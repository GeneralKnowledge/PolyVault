import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { loadConfig, recordLastPut } from "../config/store.js";
import type { ProviderConfig, ProviderKind } from "../config/types.js";
import { createProvider } from "../providers/index.js";
import { buildRemotePath } from "../util/path.js";

export interface PutOptions {
  to?: string;
  remoteDir?: string;
}

export interface ProviderPutOutcome {
  name: string;
  kind: ProviderKind;
  ok: boolean;
  remotePath?: string;
  destination?: string;
  error?: string;
  ms: number;
}

function selectProviders(
  all: ProviderConfig[],
  to?: string,
): ProviderConfig[] {
  if (!to) return all;
  const names = to.split(",").map((s) => s.trim()).filter(Boolean);
  const missing = names.filter((n) => !all.some((p) => p.name === n));
  if (missing.length > 0) {
    throw new Error(`Unknown provider(s): ${missing.join(", ")}`);
  }
  return all.filter((p) => names.includes(p.name));
}

/** Resolve local roots so we can detect accidental duplicate destinations. */
async function resolveLocalRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function assertDistinctDestinations(
  targets: ProviderConfig[],
): Promise<void> {
  const seen = new Map<string, string>();
  for (const t of targets) {
    let key: string;
    switch (t.kind) {
      case "local":
        key = `local:${await resolveLocalRoot(t.path)}`;
        break;
      case "s3":
        key = `s3:${t.endpoint}|${t.bucket}`;
        break;
      case "gdrive":
        key = `gdrive:${t.clientId}|${t.refreshToken.slice(0, 12)}`;
        break;
      case "onedrive":
        key = `onedrive:${t.clientId}|${t.refreshToken.slice(0, 12)}`;
        break;
    }
    const prior = seen.get(key);
    if (prior) {
      throw new Error(
        `Providers "${prior}" and "${t.name}" point at the same destination. ` +
          `Link distinct clouds/folders so one put fans out, not duplicate uploads.`,
      );
    }
    seen.set(key, t.name);
  }
}

export async function runPut(
  fileArg: string,
  options: PutOptions,
): Promise<ProviderPutOutcome[]> {
  const config = await loadConfig();
  if (config.providers.length === 0) {
    throw new Error("No providers configured. Add one with `polyvault provider add`.");
  }

  const filePath = resolve(fileArg);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const targets = selectProviders(config.providers, options.to);
  if (targets.length === 0) {
    throw new Error("No matching providers to upload to.");
  }

  await assertDistinctDestinations(targets);

  const remoteDir = options.remoteDir ?? config.defaultRemoteDir;
  const remotePath = buildRemotePath(remoteDir, filePath);
  const size = fileStat.size;

  console.log(`Uploading once from ${filePath}`);
  console.log(`Remote path: ${remotePath}`);
  console.log(`Fan-out to ${targets.length} distinct destination(s):\n`);
  for (const t of targets) {
    const provider = createProvider(t);
    console.log(`  • ${t.name} [${t.kind}] → ${provider.describeDestination()}`);
  }
  console.log("");

  const outcomes = await Promise.all(
    targets.map(async (providerConfig): Promise<ProviderPutOutcome> => {
      const started = Date.now();
      try {
        const provider = createProvider(providerConfig);
        // Independent stream per destination — parallel fan-out, not sequential re-puts.
        const body = createReadStream(filePath);
        const result = await provider.putObject({
          remotePath,
          body,
          size,
        });
        return {
          name: providerConfig.name,
          kind: providerConfig.kind,
          ok: true,
          remotePath: result.remotePath,
          destination: result.destination,
          ms: Date.now() - started,
        };
      } catch (err) {
        return {
          name: providerConfig.name,
          kind: providerConfig.kind,
          ok: false,
          error: err instanceof Error ? err.message : String(err),
          ms: Date.now() - started,
        };
      }
    }),
  );

  const ordered = targets.map(
    (t) => outcomes.find((o) => o.name === t.name)!,
  );

  console.log("Results:");
  for (const o of ordered) {
    if (o.ok) {
      console.log(`  ✓ ${o.name} [${o.kind}] ${o.destination} (${o.ms}ms)`);
    } else {
      console.log(`  ✗ ${o.name} [${o.kind}] FAILED (${o.ms}ms)`);
      console.log(`      ${o.error}`);
    }
  }

  const okCount = ordered.filter((o) => o.ok).length;
  const failCount = ordered.length - okCount;
  console.log(`\n${okCount} distinct destinations succeeded, ${failCount} failed`);

  await recordLastPut({
    at: new Date().toISOString(),
    file: filePath,
    remoteDir,
    results: ordered.map(
      ({ name, kind, ok, remotePath: rp, destination, error }) => ({
        name,
        kind,
        ok,
        remotePath: rp,
        destination,
        error,
      }),
    ),
  });

  return ordered;
}
