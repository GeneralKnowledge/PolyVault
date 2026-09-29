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

export interface PutResultRecord {
  at: string;
  file: string;
  remoteDir: string;
  primary?: string;
  results: Array<{
    name: string;
    kind: ProviderKind;
    ok: boolean;
    role?: "primary" | "replica";
    remotePath?: string;
    destination?: string;
    error?: string;
  }>;
}

export interface PolyVaultConfig {
  version: 1;
  defaultRemoteDir: string;
  /** Provider name that receives the original upload; others are replicas. */
  primaryProvider?: string;
  providers: ProviderConfig[];
  lastPut?: PutResultRecord;
}

export function createDefaultConfig(): PolyVaultConfig {
  return {
    version: 1,
    defaultRemoteDir: "PolyVault",
    providers: [],
  };
}
