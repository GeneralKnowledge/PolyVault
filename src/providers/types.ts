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
}

export interface CloudProvider {
  readonly kind: ProviderKind;
  readonly name: string;
  putObject(input: PutObjectInput): Promise<PutObjectResult>;
}

export type ProviderFactory = (config: ProviderConfig) => CloudProvider;
