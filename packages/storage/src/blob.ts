import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export interface BlobInfo {
  key: string;
  size: number;
  updatedAt: string;
}

/**
 * Where AppForge keeps skills, log files, project memory and reference
 * images: a folder on this machine, or an S3-compatible bucket. Keys are
 * POSIX-style relative paths like `projects/<id>/logs/run.txt`.
 */
export interface BlobStore {
  readonly kind: "local" | "cloud";
  /** Human-readable location, e.g. a folder path or s3://bucket/prefix. */
  describe(): string;
  put(key: string, data: Buffer | string, contentType?: string): Promise<void>;
  get(key: string): Promise<Buffer | undefined>;
  /** Keys under `prefix` (recursive). */
  list(prefix: string): Promise<BlobInfo[]>;
  delete(key: string): Promise<void>;
}

export function checkKey(key: string): string {
  const clean = key.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.split("/").some((part) => part === ".." || part === ".")) throw new Error(`Invalid storage key: ${key}`);
  return clean;
}

export async function getText(store: BlobStore, key: string): Promise<string | undefined> {
  return (await store.get(key))?.toString("utf8");
}

/** Plain files under a folder (default ~/.appforge/storage). */
export class LocalBlobStore implements BlobStore {
  readonly kind = "local" as const;

  constructor(readonly root: string) {}

  describe(): string {
    return this.root;
  }

  private file(key: string): string {
    return path.join(this.root, ...checkKey(key).split("/"));
  }

  async put(key: string, data: Buffer | string): Promise<void> {
    const file = this.file(key);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, data);
  }

  async get(key: string): Promise<Buffer | undefined> {
    try {
      return await readFile(this.file(key));
    } catch {
      return undefined;
    }
  }

  async list(prefix: string): Promise<BlobInfo[]> {
    const base = prefix ? this.file(prefix.replace(/\/$/, "")) : this.root;
    const out: BlobInfo[] = [];
    const walk = async (dir: string) => {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.isFile()) {
          const st = await stat(full);
          out.push({ key: path.relative(this.root, full).split(path.sep).join("/"), size: st.size, updatedAt: st.mtime.toISOString() });
        }
      }
    };
    await walk(base);
    return out.sort((a, b) => a.key.localeCompare(b.key));
  }

  async delete(key: string): Promise<void> {
    await rm(this.file(key), { force: true });
  }
}

/** For tests. */
export class MemoryBlobStore implements BlobStore {
  readonly kind = "local" as const;
  readonly data = new Map<string, { body: Buffer; updatedAt: string }>();

  describe(): string {
    return "memory";
  }
  async put(key: string, data: Buffer | string): Promise<void> {
    this.data.set(checkKey(key), { body: Buffer.from(data), updatedAt: new Date().toISOString() });
  }
  async get(key: string): Promise<Buffer | undefined> {
    return this.data.get(checkKey(key))?.body;
  }
  async list(prefix: string): Promise<BlobInfo[]> {
    return [...this.data]
      .filter(([k]) => k.startsWith(prefix))
      .map(([key, v]) => ({ key, size: v.body.length, updatedAt: v.updatedAt }))
      .sort((a, b) => a.key.localeCompare(b.key));
  }
  async delete(key: string): Promise<void> {
    this.data.delete(checkKey(key));
  }
}

/** Copy everything from one store to another (used when switching local ↔ cloud). */
export async function copyAll(from: BlobStore, to: BlobStore, onProgress?: (key: string) => void): Promise<number> {
  let count = 0;
  for (const item of await from.list("")) {
    const body = await from.get(item.key);
    if (!body) continue;
    await to.put(item.key, body);
    onProgress?.(item.key);
    count++;
  }
  return count;
}
