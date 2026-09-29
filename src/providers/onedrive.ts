import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import type { OneDriveProviderConfig } from "../config/types.js";
import { updateProviderTokens } from "../config/store.js";
import { DEFAULT_REDIRECT_URI, waitForOAuthCode } from "../oauth/server.js";
import type {
  CloudProvider,
  GetObjectResult,
  PutObjectInput,
  PutObjectResult,
} from "./types.js";

const SCOPES = ["Files.ReadWrite", "offline_access", "openid", "profile"].join(
  " ",
);

async function streamToBuffer(body: Readable | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function authBase(tenant: string): string {
  return `https://login.microsoftonline.com/${tenant}/oauth2/v2.0`;
}

export async function linkOneDrive(options: {
  name: string;
  clientId: string;
  clientSecret: string;
  tenant?: string;
  openBrowser: (url: string) => Promise<void>;
}): Promise<OneDriveProviderConfig> {
  const tenant = options.tenant ?? "common";
  const state = randomBytes(16).toString("hex");
  const redirectUri = DEFAULT_REDIRECT_URI;

  const authParams = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: SCOPES,
    state,
  });

  const authUrl = `${authBase(tenant)}/authorize?${authParams.toString()}`;
  console.log("\nOpen this URL to authorize OneDrive:\n");
  console.log(authUrl);
  console.log(`\nWaiting for redirect to ${redirectUri} ...\n`);

  const callbackPromise = waitForOAuthCode({ expectedState: state });
  await options.openBrowser(authUrl).catch(() => {
    console.log("(Could not open browser automatically — paste the URL above.)");
  });

  const { code } = await callbackPromise;

  const tokenRes = await fetch(`${authBase(tenant)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: options.clientId,
      client_secret: options.clientSecret,
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
      scope: SCOPES,
    }),
  });

  if (!tokenRes.ok) {
    throw new Error(`Microsoft token exchange failed: ${await tokenRes.text()}`);
  }

  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token: string;
    expires_in: number;
  };

  if (!tokens.refresh_token) {
    throw new Error("Microsoft did not return a refresh_token.");
  }

  return {
    kind: "onedrive",
    name: options.name,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    tenant,
  };
}

export class OneDriveProvider implements CloudProvider {
  readonly kind = "onedrive" as const;
  readonly name: string;
  private config: OneDriveProviderConfig;

  constructor(config: OneDriveProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  describeDestination(): string {
    return "OneDrive (me/drive)";
  }

  private async ensureAccessToken(): Promise<string> {
    if (
      this.config.accessToken &&
      this.config.expiresAt &&
      this.config.expiresAt > Date.now() + 60_000
    ) {
      return this.config.accessToken;
    }

    const tenant = this.config.tenant ?? "common";
    const res = await fetch(`${authBase(tenant)}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: "refresh_token",
        scope: SCOPES,
      }),
    });

    if (!res.ok) {
      throw new Error(`Microsoft token refresh failed: ${await res.text()}`);
    }

    const tokens = (await res.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in: number;
    };

    this.config = {
      ...this.config,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? this.config.refreshToken,
      expiresAt: Date.now() + tokens.expires_in * 1000,
    };

    await updateProviderTokens(this.name, {
      accessToken: this.config.accessToken,
      refreshToken: this.config.refreshToken,
      expiresAt: this.config.expiresAt,
    }).catch(() => {
      // persist best-effort
    });

    return tokens.access_token;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const accessToken = await this.ensureAccessToken();
    const body = await streamToBuffer(input.body);
    const remotePath = input.remotePath.replace(/^\/+/, "");

    // Simple upload for files < 4 MiB; otherwise create upload session.
    if (body.length < 4 * 1024 * 1024) {
      const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(remotePath)}:/content`;
      const res = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": input.contentType ?? "application/octet-stream",
        },
        body,
      });
      if (!res.ok) {
        throw new Error(`OneDrive upload failed: ${await res.text()}`);
      }
      return {
        remotePath: input.remotePath,
        destination: `onedrive:///${remotePath}`,
      };
    }

    const sessionRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(remotePath)}:/createUploadSession`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          item: {
            "@microsoft.graph.conflictBehavior": "replace",
            name: remotePath.split("/").pop(),
          },
        }),
      },
    );
    if (!sessionRes.ok) {
      throw new Error(
        `OneDrive upload session failed: ${await sessionRes.text()}`,
      );
    }
    const session = (await sessionRes.json()) as { uploadUrl: string };

    const chunkSize = 5 * 1024 * 1024;
    let offset = 0;
    while (offset < body.length) {
      const end = Math.min(offset + chunkSize, body.length);
      const chunk = body.subarray(offset, end);
      const putRes = await fetch(session.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${offset}-${end - 1}/${body.length}`,
        },
        body: chunk,
      });
      if (!putRes.ok && putRes.status !== 202) {
        throw new Error(`OneDrive chunk upload failed: ${await putRes.text()}`);
      }
      offset = end;
    }

    return {
      remotePath: input.remotePath,
      destination: `onedrive:///${remotePath}`,
    };
  }

  async getObject(remotePath: string): Promise<GetObjectResult> {
    const accessToken = await this.ensureAccessToken();
    const path = remotePath.replace(/^\/+/, "");
    const url = `https://graph.microsoft.com/v1.0/me/drive/root:/${encodeURI(path)}:/content`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
      throw new Error(`OneDrive download failed: ${await res.text()}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    return {
      body,
      size: body.length,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }

  /**
   * OneDrive Personal preview: Microsoft pulls bytes from sourceUrl (e.g. R2
   * presigned GET). Does not send the original through the laptop.
   */
  async putFromUrl(
    remotePath: string,
    sourceUrl: string,
  ): Promise<PutObjectResult> {
    const accessToken = await this.ensureAccessToken();
    const parts = remotePath.replace(/^\/+/, "").split("/").filter(Boolean);
    const fileName = parts.pop();
    if (!fileName) throw new Error("Invalid remote path");

    let parentId = "root";
    for (const part of parts) {
      parentId = await this.findOrCreateChildFolder(accessToken, parentId, part);
    }

    const res = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          Prefer: "respond-async",
        },
        body: JSON.stringify({
          "@microsoft.graph.sourceUrl": sourceUrl,
          "@microsoft.graph.conflictBehavior": "replace",
          name: fileName,
          file: {},
        }),
      },
    );

    if (!res.ok && res.status !== 202) {
      throw new Error(
        `OneDrive URL pull failed (Personal preview API): ${await res.text()}`,
      );
    }

    return {
      remotePath,
      destination: `onedrive:///${remotePath} (url-pull)`,
    };
  }

  private async findOrCreateChildFolder(
    accessToken: string,
    parentId: string,
    name: string,
  ): Promise<string> {
    const listRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children?$filter=name eq '${name.replace(/'/g, "''")}'`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    if (listRes.ok) {
      const listed = (await listRes.json()) as {
        value?: Array<{ id: string; folder?: unknown }>;
      };
      const existing = listed.value?.find((v) => v.folder !== undefined);
      if (existing) return existing.id;
    }

    const createRes = await fetch(
      `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          name,
          folder: {},
          "@microsoft.graph.conflictBehavior": "fail",
        }),
      },
    );
    if (!createRes.ok) {
      // race: folder may already exist
      const retry = await fetch(
        `https://graph.microsoft.com/v1.0/me/drive/items/${parentId}/children?$filter=name eq '${name.replace(/'/g, "''")}'`,
        { headers: { Authorization: `Bearer ${accessToken}` } },
      );
      if (retry.ok) {
        const listed = (await retry.json()) as {
          value?: Array<{ id: string; folder?: unknown }>;
        };
        const existing = listed.value?.find((v) => v.folder !== undefined);
        if (existing) return existing.id;
      }
      throw new Error(`OneDrive folder create failed: ${await createRes.text()}`);
    }
    const created = (await createRes.json()) as { id: string };
    return created.id;
  }
}
