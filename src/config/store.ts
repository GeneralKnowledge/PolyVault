import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  allProviders,
  createDefaultConfig,
  migrateConfig,
  type LegacyPolyVaultConfig,
  type PolyVaultConfig,
  type ProviderConfig,
  type PutResultRecord,
  type RelayConfig,
} from "./types.js";
import { getConfigPath, getPolyVaultHome, getSecretsPath } from "./paths.js";

/** Secrets keyed by provider name, plus optional `_relay`. */
export type SecretsStore = Record<string, Record<string, string>>;

async function ensureHome(): Promise<string> {
  const home = getPolyVaultHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await chmod(home, 0o700);
  } catch {
    // best-effort
  }
  return home;
}

async function writeRestricted(path: string, data: string): Promise<void> {
  await writeFile(path, data, { encoding: "utf8", mode: 0o600 });
  try {
    await chmod(path, 0o600);
  } catch {
    // best-effort
  }
}

function stripSecrets(provider: ProviderConfig): {
  public: ProviderConfig;
  secrets: Record<string, string>;
} {
  switch (provider.kind) {
    case "local":
      return { public: provider, secrets: {} };
    case "s3": {
      const { accessKeyId, secretAccessKey, ...rest } = provider;
      return {
        public: { ...rest, accessKeyId: "", secretAccessKey: "" },
        secrets: { accessKeyId, secretAccessKey },
      };
    }
    case "gdrive": {
      const { clientSecret, refreshToken, accessToken, ...rest } = provider;
      const secrets: Record<string, string> = { clientSecret, refreshToken };
      if (accessToken) secrets.accessToken = accessToken;
      return {
        public: {
          ...rest,
          clientSecret: "",
          refreshToken: "",
          accessToken: undefined,
        },
        secrets,
      };
    }
    case "onedrive": {
      const { clientSecret, refreshToken, accessToken, ...rest } = provider;
      const secrets: Record<string, string> = { clientSecret, refreshToken };
      if (accessToken) secrets.accessToken = accessToken;
      return {
        public: {
          ...rest,
          clientSecret: "",
          refreshToken: "",
          accessToken: undefined,
        },
        secrets,
      };
    }
    case "dropbox": {
      const { clientSecret, refreshToken, accessToken, ...rest } = provider;
      const secrets: Record<string, string> = { clientSecret, refreshToken };
      if (accessToken) secrets.accessToken = accessToken;
      return {
        public: {
          ...rest,
          clientSecret: "",
          refreshToken: "",
          accessToken: undefined,
        },
        secrets,
      };
    }
    case "webdav": {
      const { password, ...rest } = provider;
      return {
        public: { ...rest, password: "" },
        secrets: { password },
      };
    }
  }
}

function mergeSecrets(
  provider: ProviderConfig,
  secrets: Record<string, string> | undefined,
): ProviderConfig {
  if (!secrets) return provider;
  switch (provider.kind) {
    case "local":
      return provider;
    case "s3":
      return {
        ...provider,
        accessKeyId: secrets.accessKeyId ?? provider.accessKeyId,
        secretAccessKey: secrets.secretAccessKey ?? provider.secretAccessKey,
      };
    case "gdrive":
      return {
        ...provider,
        clientSecret: secrets.clientSecret ?? provider.clientSecret,
        refreshToken: secrets.refreshToken ?? provider.refreshToken,
        accessToken: secrets.accessToken ?? provider.accessToken,
      };
    case "onedrive":
      return {
        ...provider,
        clientSecret: secrets.clientSecret ?? provider.clientSecret,
        refreshToken: secrets.refreshToken ?? provider.refreshToken,
        accessToken: secrets.accessToken ?? provider.accessToken,
      };
    case "dropbox":
      return {
        ...provider,
        clientSecret: secrets.clientSecret ?? provider.clientSecret,
        refreshToken: secrets.refreshToken ?? provider.refreshToken,
        accessToken: secrets.accessToken ?? provider.accessToken,
      };
    case "webdav":
      return {
        ...provider,
        password: secrets.password ?? provider.password,
      };
  }
}

export async function configExists(): Promise<boolean> {
  return existsSync(getConfigPath());
}

export async function loadConfig(): Promise<PolyVaultConfig> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) {
    throw new Error(
      `No PolyVault config found at ${configPath}. Run \`polyvault init\` first.`,
    );
  }

  const rawJson = JSON.parse(await readFile(configPath, "utf8")) as
    | PolyVaultConfig
    | LegacyPolyVaultConfig;
  const config = migrateConfig(rawJson);

  let secrets: SecretsStore = {};
  const secretsPath = getSecretsPath();
  if (existsSync(secretsPath)) {
    secrets = JSON.parse(await readFile(secretsPath, "utf8")) as SecretsStore;
  }

  const hub = config.hub
    ? mergeSecrets(config.hub, secrets[config.hub.name])
    : undefined;
  const replicas = config.replicas.map((p) => mergeSecrets(p, secrets[p.name]));
  const relay: RelayConfig | undefined = config.relay
    ? {
        url: config.relay.url,
        token: secrets._relay?.token ?? config.relay.token,
      }
    : undefined;

  return { ...config, hub, replicas, relay };
}

export async function saveConfig(config: PolyVaultConfig): Promise<void> {
  await ensureHome();

  const secrets: SecretsStore = {};
  let publicHub: ProviderConfig | undefined;
  if (config.hub) {
    const { public: pub, secrets: sec } = stripSecrets(config.hub);
    publicHub = pub;
    if (Object.keys(sec).length > 0) secrets[config.hub.name] = sec;
  }

  const publicReplicas: ProviderConfig[] = [];
  for (const provider of config.replicas) {
    const { public: pub, secrets: sec } = stripSecrets(provider);
    publicReplicas.push(pub);
    if (Object.keys(sec).length > 0) secrets[provider.name] = sec;
  }

  if (config.relay?.token) {
    secrets._relay = { token: config.relay.token };
  }

  const publicConfig: PolyVaultConfig = {
    version: 2,
    defaultRemoteDir: config.defaultRemoteDir,
    hub: publicHub,
    replicas: publicReplicas,
    relay: config.relay
      ? { url: config.relay.url }
      : undefined,
    lastPut: config.lastPut,
  };

  await writeRestricted(getConfigPath(), JSON.stringify(publicConfig, null, 2) + "\n");
  await writeRestricted(getSecretsPath(), JSON.stringify(secrets, null, 2) + "\n");
}

export async function initConfig(force = false): Promise<PolyVaultConfig> {
  await ensureHome();
  if ((await configExists()) && !force) {
    throw new Error(
      `Config already exists at ${getConfigPath()}. Use --force to overwrite.`,
    );
  }
  const config = createDefaultConfig();
  await saveConfig(config);
  return config;
}

export async function setHub(provider: ProviderConfig): Promise<void> {
  const config = await loadConfig();
  if (config.replicas.some((p) => p.name === provider.name)) {
    throw new Error(
      `"${provider.name}" is already a replica. Choose a different name for the hub.`,
    );
  }
  // If replacing hub, keep old hub out of replicas unless user re-adds it.
  config.hub = provider;
  await saveConfig(config);
}

export async function addReplica(provider: ProviderConfig): Promise<void> {
  const config = await loadConfig();
  if (config.hub?.name === provider.name) {
    throw new Error(`"${provider.name}" is already the hub.`);
  }
  if (config.replicas.some((p) => p.name === provider.name)) {
    throw new Error(`Replica "${provider.name}" already exists.`);
  }
  config.replicas.push(provider);
  await saveConfig(config);
}

/** @deprecated Prefer setHub / addReplica. Kept for migration helpers. */
export async function addProvider(
  provider: ProviderConfig,
  asHub = false,
): Promise<void> {
  const config = await loadConfig();
  if (!config.hub || asHub) {
    await setHub(provider);
    return;
  }
  await addReplica(provider);
}

export async function setRelay(relay: RelayConfig): Promise<void> {
  const config = await loadConfig();
  config.relay = relay;
  await saveConfig(config);
}

export async function clearRelay(): Promise<void> {
  const config = await loadConfig();
  config.relay = undefined;
  await saveConfig(config);
}

export async function updateProviderTokens(
  name: string,
  tokens: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  },
): Promise<void> {
  const config = await loadConfig();
  const patch = (p: ProviderConfig): ProviderConfig => {
    if (p.name !== name) return p;
    if (p.kind !== "gdrive" && p.kind !== "onedrive" && p.kind !== "dropbox") {
      throw new Error(`Provider "${name}" does not use OAuth tokens.`);
    }
    return { ...p, ...tokens };
  };

  if (config.hub?.name === name) {
    config.hub = patch(config.hub);
  } else {
    const idx = config.replicas.findIndex((p) => p.name === name);
    if (idx < 0) throw new Error(`Provider "${name}" not found.`);
    config.replicas[idx] = patch(config.replicas[idx]!);
  }
  await saveConfig(config);
}

export async function recordLastPut(record: PutResultRecord): Promise<void> {
  const config = await loadConfig();
  config.lastPut = record;
  await saveConfig(config);
}

export function requireHub(config: PolyVaultConfig): ProviderConfig {
  if (!config.hub) {
    throw new Error(
      "No hub configured. Set a free R2/S3 hub with `polyvault hub set s3` (or `hub set local` for tests).",
    );
  }
  return config.hub;
}

export { allProviders };
