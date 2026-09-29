import { createHash, randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { GDriveProviderConfig } from "../config/types.js";
import { updateProviderTokens } from "../config/store.js";
import { DEFAULT_REDIRECT_URI, waitForOAuthCode } from "../oauth/server.js";
import type {
  CloudProvider,
  GetObjectResult,
  PutObjectInput,
  PutObjectResult,
} from "./types.js";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DRIVE_UPLOAD = "https://www.googleapis.com/upload/drive/v3/files";
const DRIVE_API = "https://www.googleapis.com/drive/v3/files";
const SCOPES = ["https://www.googleapis.com/auth/drive.file"].join(" ");

async function streamToBuffer(body: Readable | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export async function linkGoogleDrive(options: {
  name: string;
  clientId: string;
  clientSecret: string;
  openBrowser: (url: string) => Promise<void>;
}): Promise<GDriveProviderConfig> {
  const state = randomBytes(16).toString("hex");
  const { verifier, challenge } = pkce();
  const redirectUri = DEFAULT_REDIRECT_URI;

  const authParams = new URLSearchParams({
    client_id: options.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES,
    access_type: "offline",
    prompt: "consent",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  const authUrl = `${AUTH_URL}?${authParams.toString()}`;
  console.log("\nOpen this URL to authorize Google Drive:\n");
  console.log(authUrl);
  console.log(`\nWaiting for redirect to ${redirectUri} ...\n`);

  const callbackPromise = waitForOAuthCode({ expectedState: state });
  await options.openBrowser(authUrl).catch(() => {
    console.log("(Could not open browser automatically — paste the URL above.)");
  });

  const { code } = await callbackPromise;

  const tokenRes = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      code_verifier: verifier,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Google token exchange failed: ${await tokenRes.text()}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  if (!tokens.refresh_token) {
    throw new Error(
      "Google did not return a refresh_token. Revoke prior access and retry with prompt=consent.",
    );
  }

  return {
    kind: "gdrive",
    name: options.name,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
  };
}

export class GDriveProvider implements CloudProvider {
  readonly kind = "gdrive" as const;
  readonly name: string;
  private config: GDriveProviderConfig;

  constructor(config: GDriveProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  describeDestination(): string {
    return "Google Drive (My Drive)";
  }

  private async ensureAccessToken(): Promise<string> {
    if (
      this.config.accessToken &&
      this.config.expiresAt &&
      this.config.expiresAt > Date.now() + 60_000
    ) {
      return this.config.accessToken;
    }

    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!res.ok) {
      throw new Error(`Google token refresh failed: ${await res.text()}`);
    }

    const tokens = (await res.json()) as {
      access_token: string;
      expires_in: number;
    };

    this.config = {
      ...this.config,
      accessToken: tokens.access_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };

    await updateProviderTokens(this.name, {
      accessToken: this.config.accessToken,
      expiresAt: this.config.expiresAt,
    }).catch(() => {
      // persist best-effort
    });

    return tokens.access_token;
  }

  private async findOrCreateFolder(
    accessToken: string,
    parentId: string,
    name: string,
  ): Promise<string> {
    const q = encodeURIComponent(
      `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );
    const listRes = await fetch(
      `${DRIVE_API}?q=${q}&fields=files(id,name)&spaces=drive`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listRes.ok) {
      throw new Error(`Drive folder lookup failed: ${await listRes.text()}`);
    }
    const listed = (await listRes.json()) as { files?: Array<{ id: string }> };
    const existing = listed.files?.[0];
    if (existing) return existing.id;

    const createRes = await fetch(DRIVE_API, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        name,
        mimeType: "application/vnd.google-apps.folder",
        parents: [parentId],
      }),
    });
    if (!createRes.ok) {
      throw new Error(`Drive folder create failed: ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as { id: string };
    return created.id;
  }

  private async resolveParentId(
    accessToken: string,
    remotePath: string,
  ): Promise<{ parentId: string; fileName: string }> {
    const parts = remotePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid remote path");

    let parentId = "root";
    for (const part of parts) {
      parentId = await this.findOrCreateFolder(accessToken, parentId, part);
    }
    return { parentId, fileName };
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const accessToken = await this.ensureAccessToken();
    const { parentId, fileName } = await this.resolveParentId(
      accessToken,
      input.remotePath,
    );
    const body = await streamToBuffer(input.body);

    // Upsert: if a file with the same name exists in the folder, update it.
    const q = encodeURIComponent(
      `name='${fileName.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`,
    );
    const listRes = await fetch(
      `${DRIVE_API}?q=${q}&fields=files(id)&spaces=drive`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const listed = listRes.ok
      ? ((await listRes.json()) as { files?: Array<{ id: string }> })
      : { files: [] };
    const existingId = listed.files?.[0]?.id;

    const metadata = existingId
      ? {}
      : { name: fileName, parents: [parentId] };

    const boundary = `polyvault_${randomBytes(8).toString("hex")}`;
    const metaPart = Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n`,
    );
    const mediaHeader = Buffer.from(
      `--${boundary}\r\nContent-Type: ${input.contentType ?? "application/octet-stream"}\r\n\r\n`,
    );
    const footer = Buffer.from(`\r\n--${boundary}--`);
    const multipart = Buffer.concat([metaPart, mediaHeader, body, footer]);

    const url = existingId
      ? `${DRIVE_UPLOAD}/${existingId}?uploadType=multipart`
      : `${DRIVE_UPLOAD}?uploadType=multipart`;

    const res = await fetch(url, {
      method: existingId ? "PATCH" : "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
        "Content-Length": String(multipart.length),
      },
      body: multipart,
    });

    if (!res.ok) {
      throw new Error(`Google Drive upload failed: ${await res.text()}`);
    }

    return {
      remotePath: input.remotePath,
      destination: `gdrive://${input.remotePath}`,
    };
  }

  private async findFolder(
    accessToken: string,
    parentId: string,
    name: string,
  ): Promise<string | null> {
    const q = encodeURIComponent(
      `name='${name.replace(/'/g, "\\'")}' and '${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and trashed=false`,
    );
    const listRes = await fetch(
      `${DRIVE_API}?q=${q}&fields=files(id,name)&spaces=drive`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listRes.ok) {
      throw new Error(`Drive folder lookup failed: ${await listRes.text()}`);
    }
    const listed = (await listRes.json()) as { files?: Array<{ id: string }> };
    return listed.files?.[0]?.id ?? null;
  }

  private async findFileId(
    accessToken: string,
    remotePath: string,
  ): Promise<string> {
    const parts = remotePath.split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid remote path");

    let parentId = "root";
    for (const part of parts) {
      const next = await this.findFolder(accessToken, parentId, part);
      if (!next) {
        throw new Error(`Google Drive folder not found: ${part}`);
      }
      parentId = next;
    }

    const q = encodeURIComponent(
      `name='${fileName.replace(/'/g, "\\'")}' and '${parentId}' in parents and trashed=false`,
    );
    const listRes = await fetch(
      `${DRIVE_API}?q=${q}&fields=files(id)&spaces=drive`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (!listRes.ok) {
      throw new Error(`Drive file lookup failed: ${await listRes.text()}`);
    }
    const listed = (await listRes.json()) as { files?: Array<{ id: string }> };
    const id = listed.files?.[0]?.id;
    if (!id) {
      throw new Error(`Google Drive file not found: ${remotePath}`);
    }
    return id;
  }

  async getObject(remotePath: string): Promise<GetObjectResult> {
    const accessToken = await this.ensureAccessToken();
    const fileId = await this.findFileId(accessToken, remotePath);
    const res = await fetch(`${DRIVE_API}/${fileId}?alt=media`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`Google Drive download failed: ${await res.text()}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    return {
      body,
      size: body.length,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }
}
