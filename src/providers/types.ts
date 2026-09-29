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
  /** True when put was skipped because an identical-size object already existed. */
  skipped?: boolean;
}

export interface GetObjectResult {
  body: Buffer;
  size: number;
  contentType?: string;
}

export interface HeadObjectResult {
  size: number;
}

export interface CloudProvider {
  readonly kind: ProviderKind;
  readonly name: string;
  /** Human-readable destination root (folder, bucket, drive account). */
  describeDestination(): string;
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
  /** Read back an object previously stored (used to replicate from the hub). */
  getObject(remotePath: string): Promise<GetObjectResult>;
  /** Optional metadata probe for skip-if-same-size. */
  headObject?(remotePath: string): Promise<HeadObjectResult | null>;
}

export type ProviderFactory = (config: ProviderConfig) => CloudProvider;
