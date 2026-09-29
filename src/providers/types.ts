import type { Readable } from "node:stream";
import type { ProviderConfig, ProviderKind } from "../config/types.js";

export interface PutObjectInput {
  /** Remote path relative to provider root, using `/` separators (e.g. `PolyVault/hello.txt`). */
  remotePath: string;
  body: Readable | Buffer;
  size: number;
  contentType?: string;
}

export interface PutObjectResult {
  remotePath: string;
  /** Concrete destination for this provider (absolute path, s3 URI, etc.). */
  destination: string;
}

export interface CloudProvider {
  readonly kind: ProviderKind;
  readonly name: string;
  /** Human-readable destination root (folder, bucket, drive account). */
  describeDestination(): string;
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
}

export type ProviderFactory = (config: ProviderConfig) => CloudProvider;
