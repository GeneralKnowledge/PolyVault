import {
  CreateBucketCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { Readable } from "node:stream";
import type { S3ProviderConfig } from "../config/types.js";
import type {
  CloudProvider,
  GetObjectResult,
  PutObjectInput,
  PutObjectResult,
} from "./types.js";

async function streamToBuffer(body: Readable | Buffer): Promise<Buffer> {
  if (Buffer.isBuffer(body)) return body;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export class S3Provider implements CloudProvider {
  readonly kind = "s3" as const;
  readonly name: string;
  private readonly client: S3Client;
  private readonly bucket: string;
  private readonly endpoint: string;

  constructor(config: S3ProviderConfig) {
    this.name = config.name;
    this.bucket = config.bucket;
    this.endpoint = config.endpoint;
    this.client = new S3Client({
      region: config.region || "auto",
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle ?? true,
      credentials: {
        accessKeyId: config.accessKeyId,
        secretAccessKey: config.secretAccessKey,
      },
    });
  }

  describeDestination(): string {
    return `s3://${this.bucket} @ ${this.endpoint}`;
  }

  async putObject(input: PutObjectInput): Promise<PutObjectResult> {
    const key = input.remotePath.replace(/^\/+/, "");
    const body = await streamToBuffer(input.body);

    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentLength: body.length,
          ContentType: input.contentType ?? "application/octet-stream",
        }),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/NoSuchBucket|not found|404/i.test(message)) {
        throw new Error(
          `S3 bucket "${this.bucket}" not found or inaccessible: ${message}`,
        );
      }
      throw err;
    }

    return {
      remotePath: key,
      destination: `s3://${this.bucket}/${key}`,
    };
  }

  async getObject(remotePath: string): Promise<GetObjectResult> {
    const key = remotePath.replace(/^\/+/, "");
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
    );
    if (!res.Body) {
      throw new Error(`S3 object empty: s3://${this.bucket}/${key}`);
    }
    const body = await streamToBuffer(res.Body as Readable);
    return {
      body,
      size: body.length,
      contentType: res.ContentType,
    };
  }

  /** Optional helper used in tests / setup docs — create bucket if missing. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    }
  }
}
