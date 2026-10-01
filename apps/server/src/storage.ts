import path from "node:path";
import type { StorageSettings } from "@appforge/core";
import type { SecretStore } from "@appforge/providers";
import { copyAll, LocalBlobStore, S3BlobStore, SkillLibrary, type BlobStore } from "@appforge/storage";
import type { Store } from "./db/store.ts";

const SETTINGS_KEY = "storage";

export function defaultStorageSettings(dataDir: string): StorageSettings {
  return {
    mode: "local",
    local: { path: path.join(dataDir, "storage") },
    cloud: { region: "auto", bucket: "", prefix: "appforge", forcePathStyle: true },
  };
}

/**
 * Holds the active storage backend (local folder or S3-compatible cloud) for
 * skills, log files, project memory and reference images. Switching backends
 * tests the new one first and can copy everything across.
 */
export class StorageManager {
  private current: BlobStore;
  private settings: StorageSettings;
  readonly skills: SkillLibrary;

  private constructor(
    private readonly db: Store,
    private readonly secrets: SecretStore,
    private readonly dataDir: string,
    settings: StorageSettings,
    store: BlobStore,
  ) {
    this.settings = settings;
    this.current = store;
    this.skills = new SkillLibrary(() => this.current);
  }

  static async create(db: Store, secrets: SecretStore, dataDir: string, override?: BlobStore): Promise<StorageManager> {
    const settings = db.getSetting<StorageSettings>(SETTINGS_KEY, defaultStorageSettings(dataDir));
    let store: BlobStore;
    if (override) store = override;
    else {
      try {
        store = await StorageManager.open(settings, secrets);
      } catch {
        // Cloud misconfigured or offline at startup: fall back to the local folder so the app still works.
        store = new LocalBlobStore(settings.local.path || defaultStorageSettings(dataDir).local.path);
      }
    }
    return new StorageManager(db, secrets, dataDir, settings, store);
  }

  static async open(settings: StorageSettings, secrets: SecretStore): Promise<BlobStore> {
    if (settings.mode === "local") return new LocalBlobStore(settings.local.path);
    const accessKeyId = await secrets.get("s3-access-key-id");
    const secretAccessKey = await secrets.get("s3-secret-access-key");
    if (!accessKeyId || !secretAccessKey) throw new Error("Cloud storage needs an access key id and secret");
    return new S3BlobStore(settings.cloud, { accessKeyId, secretAccessKey });
  }

  get store(): BlobStore {
    return this.current;
  }

  getSettings(): StorageSettings {
    return structuredClone(this.settings);
  }

  /** Write, read back and delete a probe object. */
  static async probe(store: BlobStore): Promise<void> {
    const key = `.appforge-probe/${Date.now()}.txt`;
    await store.put(key, "ok");
    const back = await store.get(key);
    await store.delete(key);
    if (back?.toString() !== "ok") throw new Error("Storage did not return what was written");
  }

  /** Validate, optionally copy existing data across, then switch. Returns how many objects were copied. */
  async switchTo(next: StorageSettings, options: { copy: boolean }): Promise<number> {
    const clean: StorageSettings = {
      mode: next.mode === "cloud" ? "cloud" : "local",
      local: { path: next.local?.path?.trim() || defaultStorageSettings(this.dataDir).local.path },
      cloud: {
        region: next.cloud?.region?.trim() || "auto",
        bucket: next.cloud?.bucket?.trim() ?? "",
        prefix: next.cloud?.prefix?.trim() ?? "",
        forcePathStyle: next.cloud?.forcePathStyle ?? true,
        ...(next.cloud?.endpoint?.trim() ? { endpoint: next.cloud.endpoint.trim() } : {}),
      },
    };
    if (clean.mode === "local" && !path.isAbsolute(clean.local.path)) throw new Error("The local storage folder must be an absolute path");
    const store = await StorageManager.open(clean, this.secrets);
    await StorageManager.probe(store);
    let copied = 0;
    if (options.copy && store.describe() !== this.current.describe()) copied = await copyAll(this.current, store);
    this.current = store;
    this.settings = clean;
    this.db.setSetting(SETTINGS_KEY, clean);
    return copied;
  }
}
