import { createReadStream } from "node:fs";
import { copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { loadConfig, recordLastPut, requireHub } from "../config/store.js";
import type {
  ProviderConfig,
  ProviderKind,
  ReplicateMode,
} from "../config/types.js";
import { createProvider, LocalProvider, S3Provider } from "../providers/index.js";
import type { CloudProvider } from "../providers/types.js";
import { OneDriveProvider } from "../providers/onedrive.js";
import { replicateViaRelay } from "../relay/client.js";
import { buildRemotePath } from "../util/path.js";

export interface PutOptions {
  to?: string;
  remoteDir?: string;
  /** Force laptop-bridge even when relay/URL-pull is available (debug). */
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

  const hubRecommended =
    hubConfig.kind === "s3"
      ? "R2/S3 hub"
      : "local hub (tests only — use R2 for free cloud hub)";

  console.log(`Source:     ${filePath}`);
  console.log(`Remote:     ${remotePath}`);
  console.log(
    `Hub:        ${hubConfig.name} [${hubConfig.kind}] — ${hubRecommended}`,
  );
  console.log(
    `Replicas:   ${replicas.length ? replicas.map((r) => r.name).join(", ") : "(none)"}`,
  );
  if (config.relay?.url) {
    console.log(`Relay:      ${config.relay.url}`);
  } else {
    console.log(
      `Relay:      (not set — cloud replicas may use URL-pull or laptop-bridge)`,
    );
  }
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

  // Presigned GET from R2/S3 hub for URL-pull / relay.
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

  // 2) Fill replicas from the hub — never re-upload the original source.
  for (const replicaConfig of replicas) {
    const started = Date.now();
    let mode: ReplicateMode = "laptop-bridge";
    try {
      const replica = createProvider(replicaConfig);
      let destination: string;
      let remote = remotePath;

      const canRelay =
        !options.bridge &&
        config.relay?.url &&
        config.relay.token &&
        signedGetUrl &&
        (replicaConfig.kind === "gdrive" ||
          replicaConfig.kind === "onedrive" ||
          replicaConfig.kind === "s3");

      if (canRelay) {
        mode = "relay";
        const relayResult = await replicateViaRelay(config.relay!, {
          sourceUrl: signedGetUrl!,
          remotePath,
          size,
          destination: replicaConfig,
        });
        destination = relayResult.destination ?? `relay://${replicaConfig.name}`;
      } else if (
        !options.bridge &&
        replica instanceof OneDriveProvider &&
        signedGetUrl
      ) {
        mode = "onedrive-url-pull";
        const result = await replica.putFromUrl(remotePath, signedGetUrl);
        destination = result.destination;
        remote = result.remotePath;
      } else if (
        hubProvider instanceof LocalProvider &&
        replica instanceof LocalProvider
      ) {
        mode = "hub-copy";
        const result = await copyLocalHubToLocalReplica(
          hubProvider,
          replica,
          remotePath,
        );
        destination = result.destination;
      } else {
        mode = "laptop-bridge";
        if (
          replicaConfig.kind === "gdrive" ||
          replicaConfig.kind === "onedrive"
        ) {
          console.log(
            `  … ${replicaConfig.name}: no relay/URL-pull — bridging via this machine (hub→laptop→cloud)`,
          );
        }
        const result = await laptopBridge(hubProvider, replica, remotePath);
        destination = result.destination;
        remote = result.remotePath;
      }

      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode,
        ok: true,
        remotePath: remote,
        destination,
        ms: Date.now() - started,
      });
      console.log(
        `  ✓ replica ${replicaConfig.name} ← ${mode} (${Date.now() - started}ms)`,
      );
      console.log(`      ${destination}`);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcomes.push({
        name: replicaConfig.name,
        kind: replicaConfig.kind,
        role: "replica",
        mode,
        ok: false,
        error,
        ms: Date.now() - started,
      });
      console.log(`  ✗ replica ${replicaConfig.name} FAILED (${mode})`);
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
