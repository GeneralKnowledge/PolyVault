import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
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

  const remoteDir = options.remoteDir ?? config.defaultRemoteDir;
  const remotePath = buildRemotePath(remoteDir, filePath);
  const size = fileStat.size;

  console.log(`Uploading ${filePath}`);
  console.log(`Remote path: ${remotePath}`);
  console.log(`Destinations: ${targets.map((t) => t.name).join(", ")}`);
  console.log(`Fan-out: ${targets.length} parallel upload(s)\n`);

  const outcomes = await Promise.all(
    targets.map(async (providerConfig): Promise<ProviderPutOutcome> => {
      const started = Date.now();
      try {
        const provider = createProvider(providerConfig);
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

  // Stable order matching targets
  const ordered = targets.map(
    (t) => outcomes.find((o) => o.name === t.name)!,
  );

  for (const o of ordered) {
    if (o.ok) {
      console.log(`  ✓ ${o.name} [${o.kind}] ${o.remotePath} (${o.ms}ms)`);
    } else {
      console.log(`  ✗ ${o.name} [${o.kind}] FAILED (${o.ms}ms)`);
      console.log(`      ${o.error}`);
    }
  }

  const okCount = ordered.filter((o) => o.ok).length;
  const failCount = ordered.length - okCount;
  console.log(`\n${okCount} succeeded, ${failCount} failed`);

  await recordLastPut({
    at: new Date().toISOString(),
    file: filePath,
    remoteDir,
    results: ordered.map(({ name, kind, ok, remotePath: rp, error }) => ({
      name,
      kind,
      ok,
      remotePath: rp,
      error,
    })),
  });

  return ordered;
}
