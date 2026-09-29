/**
 * PolyVault free-tier relay — deploy on Oracle Always Free (or any small VM).
 *
 * Receives: presigned hub GET URL + destination credentials
 * Does:     hub → Drive / OneDrive / S3 push without using the user's laptop.
 *
 *   RELAY_TOKEN=... PORT=8787 npm run relay
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createProvider } from "../providers/index.js";
import type { ProviderConfig } from "../config/types.js";

interface ReplicateBody {
  sourceUrl: string;
  remotePath: string;
  size?: number;
  contentType?: string;
  destination: ProviderConfig;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function authorize(req: IncomingMessage, token: string): boolean {
  const header = req.headers.authorization ?? "";
  return header === `Bearer ${token}`;
}

async function handleReplicate(body: ReplicateBody): Promise<{
  ok: true;
  destination: string;
}> {
  if (!body.sourceUrl || !body.remotePath || !body.destination) {
    throw new Error("sourceUrl, remotePath, and destination are required");
  }

  const pull = await fetch(body.sourceUrl);
  if (!pull.ok) {
    throw new Error(`Failed to pull hub object: HTTP ${pull.status}`);
  }
  const buffer = Buffer.from(await pull.arrayBuffer());
  const provider = createProvider(body.destination);
  const result = await provider.putObject({
    remotePath: body.remotePath,
    body: buffer,
    size: body.size ?? buffer.length,
    contentType:
      body.contentType ?? pull.headers.get("content-type") ?? undefined,
  });
  return { ok: true, destination: result.destination };
}

export function startRelayServer(options?: {
  port?: number;
  token?: string;
}): void {
  const port = options?.port ?? Number(process.env.PORT ?? 8787);
  const token = options?.token ?? process.env.RELAY_TOKEN;
  if (!token) {
    console.error("RELAY_TOKEN is required");
    process.exit(1);
  }

  const server = createServer(async (req, res) => {
    try {
      if (req.method === "GET" && req.url === "/health") {
        json(res, 200, { ok: true, service: "polyvault-relay" });
        return;
      }

      if (req.method === "POST" && req.url === "/v1/replicate") {
        if (!authorize(req, token)) {
          json(res, 401, { ok: false, error: "Unauthorized" });
          return;
        }
        const raw = await readBody(req);
        const body = JSON.parse(raw) as ReplicateBody;
        const result = await handleReplicate(body);
        json(res, 200, result);
        return;
      }

      json(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("relay error:", message);
      json(res, 500, { ok: false, error: message });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`PolyVault relay listening on :${port}`);
  });
}
