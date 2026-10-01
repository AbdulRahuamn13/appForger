import path from "node:path";
import type { Asset } from "@appforge/core";
import { newId, nowIso } from "@appforge/core";
import type { BlobStore } from "@appforge/storage";
import type { Store } from "./db/store.ts";

const IMAGE_TYPES: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
};
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

/** Reference images: metadata in SQLite, bytes in the active storage backend. */
export class AssetService {
  constructor(
    private readonly db: Store,
    private readonly store: () => BlobStore,
  ) {}

  private key(asset: Asset): string {
    return `projects/${asset.projectId}/assets/${asset.id}${IMAGE_TYPES[asset.mediaType] ?? path.extname(asset.name)}`;
  }

  async create(projectId: string, name: string, mediaType: string, data: Buffer): Promise<Asset> {
    if (!IMAGE_TYPES[mediaType]) throw new Error("Reference images must be PNG, JPEG, GIF or WebP");
    if (data.length === 0) throw new Error("The image is empty");
    if (data.length > MAX_ASSET_BYTES) throw new Error("Images must be 10 MB or smaller");
    const asset: Asset = { id: newId("img"), projectId, name: path.basename(name).slice(0, 120) || "image", mediaType, size: data.length, createdAt: nowIso() };
    await this.store().put(this.key(asset), data, mediaType);
    this.db.insertAsset(asset);
    return asset;
  }

  async read(asset: Asset): Promise<Buffer | undefined> {
    return this.store().get(this.key(asset));
  }

  async delete(asset: Asset): Promise<void> {
    await this.store().delete(this.key(asset));
    this.db.deleteAsset(asset.id);
  }
}
