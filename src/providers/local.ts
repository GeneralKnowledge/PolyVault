import { createWriteStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import type { LocalProviderConfig } from "../config/types.js";
import type { CloudProvider, PutObjectInput, PutObjectResult } from "./types.js";

export class LocalProvider implements CloudProvider {
  readonly kind = "local" as const;
  readonly name: string;
  private readonly root: string;

  constructor(config: LocalProviderConfig) {
    this.name = config.name;
    this.root = config.path;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const dest = join(this.root, ...input.remotePath.split("/").filter(Boolean));
    await mkdir(dirname(dest), { recursive: true });

    const body =
      Buffer.isBuffer(input.body) ? Readable.from(input.body) : input.body;

    await pipeline(body, createWriteStream(dest));
    return { remotePath: input.remotePath };
  }
}
