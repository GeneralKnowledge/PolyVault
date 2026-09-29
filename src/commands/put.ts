import { createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig, recordLastPut } from "../config/store.js";
import type { ProviderConfig, ProviderKind } from "../config/types.js";
import { createProvider, LocalProvider } from "../providers/index.js";
import type { CloudProvider } from "../providers/types.js";
import { buildRemotePath } from "../util/path.js";

export interface PutOptions {
  to?: string;
  remoteDir?: string;
  /** Override which provider receives the original upload. */
  primary?: string;
}

export interface ProviderPutOutcome {
  name: string;
  kind: ProviderKind;
  role: "primary" | "replica";
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
        `Providers "${prior}" and "${t.name}" point at the same destination.`,
      );
    }
    seen.set(key, t.name);
  }
}

function pickPrimary(
  targets: ProviderConfig[],
  preferred?: string,
): ProviderConfig {
  if (preferred) {
    const found = targets.find((t) => t.name === preferred);
    if (!found) {
      throw new Error(
        `Primary provider "${preferred}" is not in the put target list.`,
      );
    }
    return found;
  }
  return targets[0]!;
}

async function replicateFromHub(
  hub: CloudProvider,
  replica: CloudProvider,
  remotePath: string,
): Promise<{ remotePath: string; destination: string }> {
  // Fast path: local → local copy from the hub file (never re-reads the original).
  if (hub instanceof LocalProvider && replica instanceof LocalProvider) {
    const src = hub.resolveAbsolute(remotePath);
    const dest = replica.resolveAbsolute(remotePath);
    await mkdir(dirname(dest), { recursive: true });
    await copyFile(src, dest);
    return { remotePath, destination: dest };
  }

  const object = await hub.getObject(remotePath);
  return replica.putObject({
    remotePath,
    body: object.body,
    size: object.size,
    contentType: object.contentType,
  });
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

  const primaryConfig = pickPrimary(
    targets,
    options.primary ?? config.primaryProvider,
  );
  const replicas = targets.filter((t) => t.name !== primaryConfig.name);

  const remoteDir = options.remoteDir ?? config.defaultRemoteDir;
  const remotePath = buildRemotePath(remoteDir, filePath);
  const size = fileStat.size;

  console.log(`Source: ${filePath}`);
  console.log(`Remote path: ${remotePath}`);
  console.log(
    `Upload once → primary "${primaryConfig.name}" [${primaryConfig.kind}]`,
  );
  if (replicas.length > 0) {
    console.log(
      `Then replicate hub → ${replicas.map((r) => r.name).join(", ")}`,
    );
  }
  console.log("");

  const outcomes: ProviderPutOutcome[] = [];

  // 1) Upload the original exactly once, to the primary hub.
  const primaryStarted = Date.now();
  const primaryProvider = createProvider(primaryConfig);
  try {
    const result = await primaryProvider.putObject({
      remotePath,
      body: createReadStream(filePath),
      size,
    });
    outcomes.push({
      name: primaryConfig.name,
      kind: primaryConfig.kind,
      role: "primary",
      ok: true,
      remotePath: result.remotePath,
      destination: result.destination,
      ms: Date.now() - primaryStarted,
    });
    console.log(
      `  ✓ primary ${primaryConfig.name} ← original upload (${outcomes[0]!.ms}ms)`,
    );
    console.log(`      ${result.destination}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    outcomes.push({
      name: primaryConfig.name,
      kind: primaryConfig.kind,
      role: "primary",
      ok: false,
      error,
      ms: Date.now() - primaryStarted,
    });
    console.log(`  ✗ primary ${primaryConfig.name} FAILED`);
    console.log(`      ${error}`);
    console.log(
      "\nPrimary upload failed — original was not uploaded; skipping replication.",
    );

    await recordLastPut({
      at: new Date().toISOString(),
      file: filePath,
      remoteDir,
      primary: primaryConfig.name,
      results: outcomes.map((o) => ({
        name: o.name,
        kind: o.kind,
        ok: o.ok,
        role: o.role,
        remotePath: o.remotePath,
        destination: o.destination,
        error: o.error,
      })),
    });
    return outcomes;
  }

  // 2) Replicate from the hub copy — do not re-upload the original source.
  if (replicas.length > 0) {
    console.log("");
    const replicaOutcomes = await Promise.all(
      replicas.map(async (replicaConfig): Promise<ProviderPutOutcome> => {
        const started = Date.now();
        try {
          const replica = createProvider(replicaConfig);
          const result = await replicateFromHub(
            primaryProvider,
            replica,
            remotePath,
          );
          return {
            name: replicaConfig.name,
            kind: replicaConfig.kind,
            role: "replica",
            ok: true,
            remotePath: result.remotePath,
            destination: result.destination,
            ms: Date.now() - started,
          };
        } catch (err) {
          return {
            name: replicaConfig.name,
            kind: replicaConfig.kind,
            role: "replica",
            ok: false,
            error: err instanceof Error ? err.message : String(err),
            ms: Date.now() - started,
          };
        }
      }),
    );
    outcomes.push(...replicaOutcomes);

    for (const o of replicaOutcomes) {
      if (o.ok) {
        console.log(
          `  ✓ replica ${o.name} ← from hub (${o.ms}ms)`,
        );
        console.log(`      ${o.destination}`);
      } else {
        console.log(`  ✗ replica ${o.name} FAILED (${o.ms}ms)`);
        console.log(`      ${o.error}`);
      }
    }
  }

  const okCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.length - okCount;
  console.log(
    `\nDone: original uploaded once to primary; ${okCount} place(s) have the file, ${failCount} failed`,
  );

  await recordLastPut({
    at: new Date().toISOString(),
    file: filePath,
    remoteDir,
    primary: primaryConfig.name,
    results: outcomes.map((o) => ({
      name: o.name,
      kind: o.kind,
      ok: o.ok,
      role: o.role,
      remotePath: o.remotePath,
      destination: o.destination,
      error: o.error,
    })),
  });

  return outcomes;
}
