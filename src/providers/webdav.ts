import type { WebDavProviderConfig } from "../config/types.js";
import type {
  CloudProvider,
  GetObjectResult,
  HeadObjectResult,
  PutObjectInput,
  PutObjectResult,
} from "./types.js";

function joinUrl(baseUrl: string, remotePath: string): string {
  const base = baseUrl.replace(/\/+$/, "");
  const path = remotePath
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
  return `${base}/${path}`;
}

function basicAuth(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
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

/**
 * Minimal WebDAV client (PUT/GET/HEAD + MKCOL for parents).
 * Works with many free/self-hosted WebDAV endpoints (Nextcloud, etc.).
 */
export class WebDavProvider implements CloudProvider {
  readonly kind = "webdav" as const;
  readonly name: string;
  private readonly baseUrl: string;
  private readonly auth: string;

  constructor(config: WebDavProviderConfig) {
    this.name = config.name;
    this.baseUrl = config.baseUrl;
    this.auth = basicAuth(config.username, config.password);
  }

  describeDestination(): string {
    return this.baseUrl;
  }

  private async ensureParentCollections(remotePath: string): Promise<void> {
    const parts = remotePath.split("/").filter(Boolean);
    parts.pop();
    let built = "";
    for (const part of parts) {
      built = built ? `${built}/${part}` : part;
      const url = joinUrl(this.baseUrl, built);
      const res = await fetch(url, {
        method: "MKCOL",
        headers: { Authorization: this.auth },
      });
      // 201 created, 405/409 already exists — all fine
      if (![201, 405, 409, 301, 302].includes(res.status) && !res.ok) {
        // some servers return 405 Method Not Allowed when collection exists
        if (res.status !== 405) {
          // continue; PUT may still succeed if parents exist
        }
      }
    }
  }

  async headObject(remotePath: string): Promise<HeadObjectResult | null> {
    const res = await fetch(joinUrl(this.baseUrl, remotePath), {
      method: "HEAD",
      headers: { Authorization: this.auth },
    });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    if (!len) return null;
    return { size: Number(len) };
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    await this.ensureParentCollections(input.remotePath);
    const body = await streamToBuffer(input.body);
    const url = joinUrl(this.baseUrl, input.remotePath);
    const res = await fetch(url, {
      method: "PUT",
      headers: {
        Authorization: this.auth,
        "Content-Type": input.contentType ?? "application/octet-stream",
        "Content-Length": String(body.length),
      },
      body,
    });
    if (!res.ok) {
      throw new Error(`WebDAV PUT failed (${res.status}): ${await res.text()}`);
    }
    return { remotePath: input.remotePath, destination: url };
  }

  async getObject(remotePath: string): Promise<GetObjectResult> {
    const res = await fetch(joinUrl(this.baseUrl, remotePath), {
      method: "GET",
      headers: { Authorization: this.auth },
    });
    if (!res.ok) {
      throw new Error(`WebDAV GET failed (${res.status}): ${await res.text()}`);
    }
    const body = Buffer.from(await res.arrayBuffer());
    return {
      body,
      size: body.length,
      contentType: res.headers.get("content-type") ?? undefined,
    };
  }
}
