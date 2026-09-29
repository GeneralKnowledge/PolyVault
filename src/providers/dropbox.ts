import { randomBytes } from "node:crypto";
import type { DropboxProviderConfig } from "../config/types.js";
import { updateProviderTokens } from "../config/store.js";
import { DEFAULT_REDIRECT_URI, waitForOAuthCode } from "../oauth/server.js";
import type {
  CloudProvider,
  GetObjectResult,
  HeadObjectResult,
  PutObjectInput,
  PutObjectResult,
} from "./types.js";

const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const API = "https://api.dropboxapi.com/2";
const CONTENT = "https://content.dropboxapi.com/2";

function toDropboxPath(remotePath: string): string {
  const p = remotePath.replace(/^\/+/, "");
  return `/${p}`;
}

async function streamToBuffer(
  body: PutObjectInput["body"],
): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export async function linkDropbox(options: {
  name: string;
  clientId: string;
  clientSecret: string;
  openBrowser: (url: string) => Promise<void>;
}): Promise<DropboxProviderConfig> {
  const state = randomBytes(16).toString("hex");
  const redirectUri = DEFAULT_REDIRECT_URI;
  const params = new URLSearchParams({
    client_id: options.clientId,
    response_type: "code",
    token_access_type: "offline",
    redirect_uri: redirectUri,
    state,
  });
  const authUrl = `${AUTH_URL}?${params.toString()}`;
  console.log("\nOpen this URL to authorize Dropbox:\n");
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
      grant_type: "authorization_code",
      client_id: options.clientId,
      client_secret: options.clientSecret,
      redirect_uri: redirectUri,
    }),
  });
  if (!tokenRes.ok) {
    throw new Error(`Dropbox token exchange failed: ${await tokenRes.text()}`);
  }
  const tokens = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  if (!tokens.refresh_token) {
    throw new Error(
      "Dropbox did not return a refresh_token. Ensure the app allows offline access.",
    );
  }

  return {
    kind: "dropbox",
    name: options.name,
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    refreshToken: tokens.refresh_token,
    accessToken: tokens.access_token,
    expiresAt: tokens.expires_in
      ? Date.now() + tokens.expires_in * 1000
      : undefined,
  };
}

export class DropboxProvider implements CloudProvider {
  readonly kind = "dropbox" as const;
  readonly name: string;
  private config: DropboxProviderConfig;

  constructor(config: DropboxProviderConfig) {
    this.name = config.name;
    this.config = config;
  }

  describeDestination(): string {
    return "Dropbox";
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
        grant_type: "refresh_token",
        refresh_token: this.config.refreshToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Dropbox token refresh failed: ${await res.text()}`);
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
    }).catch(() => undefined);
    return tokens.access_token;
  }

  async headObject(remotePath: string): Promise<HeadObjectResult | null> {
    const accessToken = await this.ensureAccessToken();
    const res = await fetch(`${API}/files/get_metadata`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ path: toDropboxPath(remotePath) }),
    });
    if (res.status === 409) return null;
    if (!res.ok) return null;
    const meta = (await res.json()) as { size?: number; ".tag"?: string };
    if (meta[".tag"] === "file" && typeof meta.size === "number") {
      return { size: meta.size };
    }
    return null;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const accessToken = await this.ensureAccessToken();
    const path = toDropboxPath(input.remotePath);
    const body = await streamToBuffer(input.body);

    const res = await fetch(`${CONTENT}/files/upload`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/octet-stream",
        "Dropbox-API-Arg": JSON.stringify({
          path,
          mode: "overwrite",
          autorename: false,
          mute: true,
        }),
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`Dropbox upload failed: ${await res.text()}`);
    }
    return { remotePath: input.remotePath, destination: `dropbox://${path}` };
  }

  async getObject(remotePath: string): Promise<GetObjectResult> {
    const accessToken = await this.ensureAccessToken();
    const res = await fetch(`${CONTENT}/files/download`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Dropbox-API-Arg": JSON.stringify({
          path: toDropboxPath(remotePath),
        }),
      },
    });
    if (!res.ok) {
      throw new Error(`Dropbox download failed: ${await res.text()}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    return { body, size: body.length };
  }
}
