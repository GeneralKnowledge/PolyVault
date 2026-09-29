/**
 * PolyVault free-tier relay — deploy on Oracle Always Free (or any small VM).
 *
 * One hub pull → many destinations in parallel, with retries and
 * skip-if-same-size.
 *
 *   RELAY_TOKEN=... PORT=8787 npm run relay
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createProvider } from "../providers/index.js";
import type { ProviderConfig } from "../config/types.js";
import { withRetry } from "../util/retry.js";

interface ReplicateBody {
  sourceUrl: string;
  remotePath: string;
  size?: number;
  contentType?: string;
  /** @deprecated single destination — prefer destinations[] */
  destination?: ProviderConfig;
  destinations?: ProviderConfig[];
  options?: {
    retries?: number;
    skipIfSameSize?: boolean;
  };
}

export interface RelayDestResult {
  name: string;
  kind: string;
  ok: boolean;
  skipped?: boolean;
  destination?: string;
  error?: string;
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

async function pushOne(
  dest: ProviderConfig,
  remotePath: string,
  buffer: Buffer,
  contentType: string | undefined,
  opts: { retries: number; skipIfSameSize: boolean },
): Promise<RelayDestResult> {
  try {
    const provider = createProvider(dest);

    if (opts.skipIfSameSize && provider.headObject) {
      const head = await provider.headObject(remotePath);
      if (head && head.size === buffer.length) {
        return {
          name: dest.name,
          kind: dest.kind,
          ok: true,
          skipped: true,
          destination: `${provider.describeDestination()} (skipped, same size)`,
        };
      }
    }

    const result = await withRetry(
      () =>
        provider.putObject({
          remotePath,
          body: buffer,
          size: buffer.length,
          contentType,
        }),
      { attempts: opts.retries, label: dest.name },
    );

    return {
      name: dest.name,
      kind: dest.kind,
      ok: true,
      skipped: result.skipped,
      destination: result.destination,
    };
  } catch (err) {
    return {
      name: dest.name,
      kind: dest.kind,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function handleReplicate(body: ReplicateBody): Promise<{
  ok: boolean;
  results: RelayDestResult[];
  /** Back-compat for single-destination clients */
  destination?: string;
  error?: string;
}> {
  if (!body.sourceUrl || !body.remotePath) {
    throw new Error("sourceUrl and remotePath are required");
  }

  const destinations =
    body.destinations && body.destinations.length > 0
      ? body.destinations
      : body.destination
        ? [body.destination]
        : [];

  if (destinations.length === 0) {
    throw new Error("destinations[] (or destination) is required");
  }

  const pull = await withRetry(async () => {
    const res = await fetch(body.sourceUrl);
    if (!res.ok) {
      throw new Error(`Failed to pull hub object: HTTP ${res.status}`);
    }
    return res;
  }, { attempts: 3 });

  const buffer = Buffer.from(await pull.arrayBuffer());
  const contentType =
    body.contentType ?? pull.headers.get("content-type") ?? undefined;
  const retries = body.options?.retries ?? 3;
  const skipIfSameSize = body.options?.skipIfSameSize ?? true;

  // One hub download → fan-out in parallel
  const results = await Promise.all(
    destinations.map((dest) =>
      pushOne(dest, body.remotePath, buffer, contentType, {
        retries,
        skipIfSameSize,
      }),
    ),
  );

  const ok = results.every((r) => r.ok);
  return {
    ok,
    results,
    destination: results[0]?.destination,
    error: ok
      ? undefined
      : results
          .filter((r) => !r.ok)
          .map((r) => `${r.name}: ${r.error}`)
          .join("; "),
  };
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
        json(res, result.ok ? 200 : 207, result);
        return;
      }

      json(res, 404, { ok: false, error: "Not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("relay error:", message);
      json(res, 500, { ok: false, error: message, results: [] });
    }
  });

  server.listen(port, "0.0.0.0", () => {
    console.log(`PolyVault relay listening on :${port}`);
  });
}
