import { createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig, recordLastPut, requireHub } from "../config/store.js";
import type {
  ProviderConfig,
  ProviderKind,
  ReplicateMode,
} from "../config/types.js";
import { isCloudReplica } from "../config/types.js";
import { createProvider, LocalProvider, S3Provider } from "../providers/index.js";
import type { CloudProvider } from "../providers/types.js";
import { OneDriveProvider } from "../providers/onedrive.js";
import { replicateViaRelay } from "../relay/client.js";
import { buildRemotePath } from "../util/path.js";

export interface PutOptions {
  to?: string;
  remoteDir?: string;
  /** Allow laptop-bridge for cloud replicas (debug / no relay). */
  bridge?: boolean;
}

export interface ProviderPutOutcome {
  name: string;
  kind: ProviderKind;
  role: "hub" | "replica";
  mode: ReplicateMode;
  ok: boolean;
  remotePath?: string;
  destination?: string;
  error?: string;
  ms: number;
}

async function resolveLocalRoot(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function assertDistinctFromHub(
  hub: ProviderConfig,
  replicas: ProviderConfig[],
): Promise<void> {
  const hubKey =
    hub.kind === "local"
      ? `local:${await resolveLocalRoot(hub.path)}`
      : hub.kind === "s3"
        ? `s3:${hub.endpoint}|${hub.bucket}`
        : `${hub.kind}:${hub.name}`;

  for (const t of replicas) {
    const key =
      t.kind === "local"
        ? `local:${await resolveLocalRoot(t.path)}`
        : t.kind === "s3"
          ? `s3:${t.endpoint}|${t.bucket}`
          : `${t.kind}:${t.name}`;
    if (key === hubKey) {
      throw new Error(
        `Replica "${t.name}" points at the same place as hub "${hub.name}".`,
      );
    }
  }
}

async function copyLocalHubToLocalReplica(
  hub: LocalProvider,
  replica: LocalProvider,
  remotePath: string,
): Promise<{ remotePath: string; destination: string }> {
  const src = hub.resolveAbsolute(remotePath);
  const dest = replica.resolveAbsolute(remotePath);
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  return { remotePath, destination: dest };
}

async function laptopBridge(
  hub: CloudProvider,
  replica: CloudProvider,
  remotePath: string,
): Promise<{ remotePath: string; destination: string }> {
  if (hub instanceof LocalProvider && replica instanceof LocalProvider) {
    return copyLocalHubToLocalReplica(hub, replica, remotePath);
  }
  const object = await hub.getObject(remotePath);
  return replica.putObject({
    remotePath,
    body: object.body,
    size: object.size,
    contentType: object.contentType,
  });
}

function selectReplicas(
  all: ProviderConfig[],
  to?: string,
): ProviderConfig[] {
  if (!to) return all;
  const names = to.split(",").map((s) => s.trim()).filter(Boolean);
  const missing = names.filter((n) => !all.some((p) => p.name === n));
  if (missing.length > 0) {
    throw new Error(`Unknown replica(s): ${missing.join(", ")}`);
  }
  return all.filter((p) => names.includes(p.name));
}

export async function runPut(
  fileArg: string,
  options: PutOptions,
): Promise<ProviderPutOutcome[]> {
  const config = await loadConfig();
  const hubConfig = requireHub(config);
  const replicas = selectReplicas(config.replicas, options.to);
  await assertDistinctFromHub(hubConfig, replicas);

  const filePath = resolve(fileArg);
  const fileStat = await stat(filePath);
  if (!fileStat.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const remoteDir = options.remoteDir ?? config.defaultRemoteDir;
  const remotePath = buildRemotePath(remoteDir, filePath);
  const size = fileStat.size;

  console.log(`Source:     ${filePath}`);
  console.log(`Remote:     ${remotePath}`);
  console.log(`Hub:        ${hubConfig.name} [${hubConfig.kind}]`);
  console.log(
    `Replicas:   ${replicas.length ? replicas.map((r) => r.name).join(", ") : "(none)"}`,
  );
  console.log(`Relay:      ${config.relay?.url ?? "(not set)"}`);
  console.log("");

  const outcomes: ProviderPutOutcome[] = [];
  const hubProvider = createProvider(hubConfig);

  // 1) Upload original once to the free hub.
  const hubStarted = Date.now();
  try {
    const result = await hubProvider.putObject({
      remotePath,
      body: createReadStream(filePath),
      size,
    });
    outcomes.push({
      name: hubConfig.name,
      kind: hubConfig.kind,
      role: "hub",
      mode: "hub-upload",
      ok: true,
      remotePath: result.remotePath,
      destination: result.destination,
      ms: Date.now() - hubStarted,
    });
    console.log(`  ✓ hub ${hubConfig.name} ← original upload (${outcomes[0]!.ms}ms)`);
    console.log(`      ${result.destination}`);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    outcomes.push({
      name: hubConfig.name,
      kind: hubConfig.kind,
      role: "hub",
      mode: "hub-upload",
      ok: false,
      error,
      ms: Date.now() - hubStarted,
    });
    console.log(`  ✗ hub ${hubConfig.name} FAILED`);
    console.log(`      ${error}`);
    await recordLastPut({
      at: new Date().toISOString(),
      file: filePath,
      remoteDir,
      hub: hubConfig.name,
      results: outcomes,
    });
    return outcomes;
  }

  let signedGetUrl: string | undefined;
  if (hubProvider instanceof S3Provider) {
    try {
      signedGetUrl = await hubProvider.getSignedGetUrl(remotePath, 3600);
    } catch (err) {
      console.warn(
        `  ! could not create hub signed URL: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Partition replicas
  const urlPull: ProviderConfig[] = [];
  const relayBatch: ProviderConfig[] = [];
  const localCopies: ProviderConfig[] = [];
  const bridgeNeeded: ProviderConfig[] = [];

  for (const r of replicas) {
    if (r.kind === "local") {
      localCopies.push(r);
      continue;
    }
    if (
      !options.bridge &&
      r.kind === "onedrive" &&
      signedGetUrl
    ) {
      urlPull.push(r);
      continue;
    }
    if (
      !options.bridge &&
      config.relay?.url &&
      config.relay.token &&
      signedGetUrl &&
      isCloudReplica(r.kind)
    ) {
      relayBatch.push(r);
      continue;
    }
    bridgeNeeded.push(r);
  }

  // 2a) OneDrive URL-pull (Microsoft fetches R2)
  for (const replicaConfig of urlPull) {
    const started = Date.now();
    try {
      const replica = createProvider(replicaConfig) as OneDriveProvider;
      const result = await replica.putFromUrl(remotePath, signedGetUrl!);
      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode: "onedrive-url-pull",
        ok: true,
        remotePath: result.remotePath,
        destination: result.destination,
        ms: Date.now() - started,
      });
      console.log(
        `  ✓ replica ${replicaConfig.name} ← onedrive-url-pull (${Date.now() - started}ms)`,
      );
      console.log(`      ${result.destination}`);
    } catch (err) {
      // Fall through to relay batch if available
      if (config.relay?.url && config.relay.token && signedGetUrl) {
        console.log(
          `  … ${replicaConfig.name}: URL-pull failed, queueing to relay`,
        );
        relayBatch.push(replicaConfig);
      } else {
        const error = err instanceof Error ? err.message : String(err);
        outcomes.push({
          name: replicaConfig.name,
          kind: replicaConfig.kind,
          role: "replica",
          mode: "onedrive-url-pull",
          ok: false,
          error,
          ms: Date.now() - started,
        });
        console.log(`  ✗ replica ${replicaConfig.name} FAILED (onedrive-url-pull)`);
        console.log(`      ${error}`);
      }
    }
  }

  // 2b) One relay job: hub pull once → many destinations in parallel
  if (relayBatch.length > 0) {
    const started = Date.now();
    console.log(
      `  … relay fan-out → ${relayBatch.map((r) => r.name).join(", ")}`,
    );
    try {
      const relayResult = await replicateViaRelay(config.relay!, {
        sourceUrl: signedGetUrl!,
        remotePath,
        size,
        destinations: relayBatch,
        options: { retries: 3, skipIfSameSize: true },
      });
      const byName = new Map(
        relayResult.results.map((r) => [r.name, r] as const),
      );
      for (const dest of relayBatch) {
        const r = byName.get(dest.name);
        if (!r) {
          outcomes.push({
            name: dest.name,
            kind: dest.kind,
            role: "replica",
            mode: "relay",
            ok: false,
            error: "Missing result from relay",
            ms: Date.now() - started,
          });
          continue;
        }
        const mode: ReplicateMode = r.skipped ? "skipped" : "relay";
        outcomes.push({
          name: dest.name,
          kind: dest.kind,
          role: "replica",
          mode,
          ok: r.ok,
          remotePath,
          destination: r.destination,
          error: r.error,
          ms: Date.now() - started,
        });
        if (r.ok) {
          console.log(
            `  ✓ replica ${dest.name} ← ${mode}`,
          );
          console.log(`      ${r.destination}`);
        } else {
          console.log(`  ✗ replica ${dest.name} FAILED (relay)`);
          console.log(`      ${r.error}`);
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      for (const dest of relayBatch) {
        outcomes.push({
          name: dest.name,
          kind: dest.kind,
          role: "replica",
          mode: "relay",
          ok: false,
          error,
          ms: Date.now() - started,
        });
        console.log(`  ✗ replica ${dest.name} FAILED (relay)`);
        console.log(`      ${error}`);
      }
    }
  }

  // 2c) Local replicas — copy from local hub, or pull from cloud hub onto disk
  for (const replicaConfig of localCopies) {
    const started = Date.now();
    try {
      const replica = createProvider(replicaConfig);
      if (!(replica instanceof LocalProvider)) {
        throw new Error("Expected local provider");
      }
      const head = await replica.headObject(remotePath);
      if (head && head.size === size) {
        outcomes.push({
          name: replicaConfig.name,
          kind: replicaConfig.kind,
          role: "replica",
          mode: "skipped",
          ok: true,
          remotePath,
          destination: replica.resolveAbsolute(remotePath),
          ms: Date.now() - started,
        });
        console.log(`  ✓ replica ${replicaConfig.name} ← skipped (same size)`);
        continue;
      }

      let result: { remotePath: string; destination: string };
      let mode: ReplicateMode;
      if (hubProvider instanceof LocalProvider) {
        mode = "hub-copy";
        result = await copyLocalHubToLocalReplica(
          hubProvider,
          replica,
          remotePath,
        );
      } else {
        // Pull hub object down to a local folder (not a re-upload of the original).
        mode = "hub-copy";
        result = await laptopBridge(hubProvider, replica, remotePath);
      }
      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode,
        ok: true,
        remotePath: result.remotePath,
        destination: result.destination,
        ms: Date.now() - started,
      });
      console.log(
        `  ✓ replica ${replicaConfig.name} ← ${mode} (${Date.now() - started}ms)`,
      );
      console.log(`      ${result.destination}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode: "hub-copy",
        ok: false,
        error,
        ms: Date.now() - started,
      });
      console.log(`  ✗ replica ${replicaConfig.name} FAILED (hub-copy)`);
      console.log(`      ${error}`);
    }
  }

  // 2d) Cloud without relay/URL-pull
  for (const replicaConfig of bridgeNeeded) {
    if (!options.bridge && isCloudReplica(replicaConfig.kind)) {
      const msg =
        `No off-laptop path for "${replicaConfig.name}". ` +
        `Configure R2 hub + Oracle relay (docs/SETUP.md), or pass --bridge to force laptop transit.`;
      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode: "laptop-bridge",
        ok: false,
        error: msg,
        ms: 0,
      });
      console.log(`  ✗ replica ${replicaConfig.name} FAILED`);
      console.log(`      ${msg}`);
      continue;
    }

    const started = Date.now();
    try {
      const replica = createProvider(replicaConfig);
      const result = await laptopBridge(hubProvider, replica, remotePath);
      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode: "laptop-bridge",
        ok: true,
        remotePath: result.remotePath,
        destination: result.destination,
        ms: Date.now() - started,
      });
      console.log(
        `  ✓ replica ${replicaConfig.name} ← laptop-bridge (${Date.now() - started}ms)`,
      );
      console.log(`      ${result.destination}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode: "laptop-bridge",
        ok: false,
        error,
        ms: Date.now() - started,
      });
      console.log(`  ✗ replica ${replicaConfig.name} FAILED (laptop-bridge)`);
      console.log(`      ${error}`);
    }
  }

  const okCount = outcomes.filter((o) => o.ok).length;
  const failCount = outcomes.length - okCount;
  console.log(
    `\nDone: original uploaded once to hub; ${okCount} place(s) OK, ${failCount} failed`,
  );

  await recordLastPut({
    at: new Date().toISOString(),
    file: filePath,
    remoteDir,
    hub: hubConfig.name,
    results: outcomes.map((o) => ({
      name: o.name,
      kind: o.kind,
      ok: o.ok,
      role: o.role,
      mode: o.mode,
      remotePath: o.remotePath,
      destination: o.destination,
      error: o.error,
    })),
  });

  return outcomes;
}
