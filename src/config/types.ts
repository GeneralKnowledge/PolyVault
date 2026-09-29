export type ProviderKind = "local" | "s3" | "gdrive" | "onedrive";

export interface LocalProviderConfig {
  kind: "local";
  name: string;
  path: string;
}

export interface S3ProviderConfig {
  kind: "s3";
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  forcePathStyle?: boolean;
}

export interface GDriveProviderConfig {
  kind: "gdrive";
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
}

export interface OneDriveProviderConfig {
  kind: "onedrive";
  name: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  tenant?: string;
}

export type ProviderConfig =
  | LocalProviderConfig
  | S3ProviderConfig
  | GDriveProviderConfig
  | OneDriveProviderConfig;

/** Optional free-tier relay that streams hub → Drive/OneDrive off-laptop. */
export interface RelayConfig {
  url: string;
  /** Present only after secrets merge. */
  token?: string;
}

export type ReplicateMode =
  | "hub-upload"
  | "relay"
  | "onedrive-url-pull"
  | "hub-copy"
  | "laptop-bridge";

export interface PutResultRecord {
  at: string;
  file: string;
  remoteDir: string;
  hub?: string;
  results: Array<{
    name: string;
    kind: ProviderKind;
    ok: boolean;
    role?: "hub" | "replica";
    mode?: ReplicateMode;
    remotePath?: string;
    destination?: string;
    error?: string;
  }>;
}

export interface PolyVaultConfig {
  version: 2;
  defaultRemoteDir: string;
  /** Canonical free hub — preferably Cloudflare R2 (s3). Local hub OK for tests. */
  hub?: ProviderConfig;
  /** Destinations filled from the hub (not from another original upload). */
  replicas: ProviderConfig[];
  relay?: RelayConfig;
  lastPut?: PutResultRecord;
}

export function createDefaultConfig(): PolyVaultConfig {
  return {
    version: 2,
    defaultRemoteDir: "PolyVault",
    replicas: [],
  };
}

/** Legacy v1 shape (providers + primaryProvider). */
export interface LegacyPolyVaultConfig {
  version: 1;
  defaultRemoteDir: string;
  primaryProvider?: string;
  providers: ProviderConfig[];
  lastPut?: PutResultRecord;
  relay?: RelayConfig;
}

export function migrateConfig(
  raw: PolyVaultConfig | LegacyPolyVaultConfig,
): PolyVaultConfig {
  if (raw.version === 2) {
    return {
      ...createDefaultConfig(),
      ...raw,
      version: 2,
      replicas: raw.replicas ?? [],
    };
  }

  const legacy = raw;
  const primaryName = legacy.primaryProvider ?? legacy.providers[0]?.name;
  const hub = legacy.providers.find((p) => p.name === primaryName);
  const replicas = legacy.providers.filter((p) => p.name !== primaryName);

  return {
    version: 2,
    defaultRemoteDir: legacy.defaultRemoteDir,
    hub,
    replicas,
    relay: legacy.relay,
    lastPut: legacy.lastPut,
  };
}

export function allProviders(config: PolyVaultConfig): ProviderConfig[] {
  return config.hub ? [config.hub, ...config.replicas] : [...config.replicas];
}
