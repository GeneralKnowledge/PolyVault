import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import {
  createDefaultConfig,
  type PolyVaultConfig,
  type ProviderConfig,
  type PutResultRecord,
} from "./types.js";
import { getConfigPath, getPolyVaultHome, getSecretsPath } from "./paths.js";

/** Secrets that should live in secrets.json (mode 0600), keyed by provider name. */
export type SecretsStore = Record<string, Record<string, string>>;

async function ensureHome(): Promise<string> {
  const home = getPolyVaultHome();
  await mkdir(home, { recursive: true, mode: 0o700 });
  try {
    await chmod(home, 0o700);
  } catch {
    // best-effort on platforms that ignore mode
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
      const secrets: Record<string, string> = {
        clientSecret,
        refreshToken,
      };
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
      const secrets: Record<string, string> = {
        clientSecret,
        refreshToken,
      };
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

  const raw = await readFile(configPath, "utf8");
  const config = JSON.parse(raw) as PolyVaultConfig;

  let secrets: SecretsStore = {};
  const secretsPath = getSecretsPath();
  if (existsSync(secretsPath)) {
    secrets = JSON.parse(await readFile(secretsPath, "utf8")) as SecretsStore;
  }

  return {
    ...config,
    providers: config.providers.map((p) => mergeSecrets(p, secrets[p.name])),
  };
}

export async function saveConfig(config: PolyVaultConfig): Promise<void> {
  await ensureHome();

  const secrets: SecretsStore = {};
  const publicProviders: ProviderConfig[] = [];

  for (const provider of config.providers) {
    const { public: pub, secrets: sec } = stripSecrets(provider);
    publicProviders.push(pub);
    if (Object.keys(sec).length > 0) {
      secrets[provider.name] = sec;
    }
  }

  const publicConfig: PolyVaultConfig = {
    ...config,
    providers: publicProviders,
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

export async function addProvider(provider: ProviderConfig): Promise<void> {
  const config = await loadConfig();
  if (config.providers.some((p) => p.name === provider.name)) {
    throw new Error(`Provider "${provider.name}" already exists.`);
  }
  config.providers.push(provider);
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
  const idx = config.providers.findIndex((p) => p.name === name);
  if (idx < 0) throw new Error(`Provider "${name}" not found.`);
  const provider = config.providers[idx]!;
  if (provider.kind !== "gdrive" && provider.kind !== "onedrive") {
    throw new Error(`Provider "${name}" does not use OAuth tokens.`);
  }
  config.providers[idx] = {
    ...provider,
    ...tokens,
  };
  await saveConfig(config);
}

export async function recordLastPut(record: PutResultRecord): Promise<void> {
  const config = await loadConfig();
  config.lastPut = record;
  await saveConfig(config);
}
