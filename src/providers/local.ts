import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { LocalProviderConfig } from "../config/types.js";
import type {
  CloudProvider,
  GetObjectResult,
  PutObjectInput,
  PutObjectResult,
} from "./types.js";

export class LocalProvider implements CloudProvider {
  readonly kind = "local" as const;
  readonly name: string;
  private readonly root: string;

  constructor(config: LocalProviderConfig) {
    this.name = config.name;
    this.root = config.path;
  }

  describeDestination(): string {
    return this.root;
  }

  private absolutePath(remotePath: string): string {
    return join(this.root, ...remotePath.split("/").filter(Boolean));
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const dest = this.absolutePath(input.remotePath);
    await mkdir(dirname(dest), { recursive: true });

    const body =
      Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body;

    await pipeline(body, createWriteStream(dest));
    return { remotePath: input.remotePath, destination: dest };
  }

  async getObject(remotePath: string): Promise<GetObjectResult> {
    const abs = this.absolutePath(remotePath);
    const body = await readFile(abs);
    return { body, size: body.length };
  }

  /** Direct filesystem path for efficient local→local replication. */
  resolveAbsolute(remotePath: string): string {
    return this.absolutePath(remotePath);
  }

  createReadStream(remotePath: string): Readable {
    return createReadStream(this.absolutePath(remotePath));
  }
}
