import { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, NoSuchKey, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import type { StorageSettings } from "@appforge/core";
import { checkKey, type BlobInfo, type BlobStore } from "./blob.ts";

export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

/**
 * Any S3-compatible bucket (AWS S3, Cloudflare R2, MinIO, Backblaze B2...).
 * Credentials come from the OS keychain; nothing is written to disk.
 */
export class S3BlobStore implements BlobStore {
  readonly kind = "cloud" as const;
  private readonly client: S3Client;
  private readonly prefix: string;

  constructor(
    private readonly config: StorageSettings["cloud"],
    credentials: S3Credentials,
  ) {
    if (!config.bucket) throw new Error("Cloud storage needs a bucket name");
    this.client = new S3Client({
      region: config.region || "us-east-1",
      credentials,
      forcePathStyle: config.forcePathStyle,
      ...(config.endpoint ? { endpoint: config.endpoint } : {}),
      // Plain payloads work with every S3-compatible service.
      requestChecksumCalculation: "WHEN_REQUIRED",
      responseChecksumValidation: "WHEN_REQUIRED",
    });
    this.prefix = config.prefix ? `${config.prefix.replace(/^\/+|\/+$/g, "")}/` : "";
  }

  describe(): string {
    return `s3://${this.config.bucket}/${this.prefix}${this.config.endpoint ? ` (${this.config.endpoint})` : ""}`;
  }

  private key(key: string): string {
    return `${this.prefix}${checkKey(key)}`;
  }

  async put(key: string, data: Buffer | string, contentType?: string): Promise<void> {
    await this.client.send(new PutObjectCommand({ Bucket: this.config.bucket, Key: this.key(key), Body: Buffer.from(data), ...(contentType ? { ContentType: contentType } : {}) }));
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }));
      const bytes = await res.Body?.transformToByteArray();
      return bytes ? Buffer.from(bytes) : undefined;
    } catch (err) {
      if (err instanceof NoSuchKey || (err as { name?: string }).name === "NoSuchKey" || (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return undefined;
      throw err;
    }
  }

  async list(prefix: string): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(
        new ListObjectsV2Command({ Bucket: this.config.bucket, Prefix: `${this.prefix}${prefix}`, ...(token ? { ContinuationToken: token } : {}) }),
      );
      for (const obj of res.Contents ?? []) {
        if (!obj.Key) continue;
        out.push({ key: obj.Key.slice(this.prefix.length), size: obj.Size ?? 0, updatedAt: (obj.LastModified ?? new Date()).toISOString() });
      }
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: this.key(key) }));
  }
}
