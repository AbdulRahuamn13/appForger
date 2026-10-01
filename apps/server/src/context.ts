import type { Orchestrator } from "@appforge/orchestrator";
import type { ProviderRegistry, SecretStore } from "@appforge/providers";
import type { ProjectTesting } from "@appforge/testing";
import type { ProcessRegistry } from "@appforge/workspace";
import type { AssetService } from "./assets.ts";
import type { Store } from "./db/store.ts";
import type { LogService, MemoryService } from "./logs.ts";
import type { PreviewService } from "./preview.ts";
import type { StorageManager } from "./storage.ts";
import type { StoryService } from "./stories.ts";
import type { Hub } from "./hub.ts";

export interface AppContext {
  store: Store;
  hub: Hub;
  dataDir: string;
  providers: ProviderRegistry;
  secrets: SecretStore;
  processes: ProcessRegistry;
  testing: ProjectTesting;
  orchestrator: Orchestrator;
  storage: StorageManager;
  logs: LogService;
  memory: MemoryService;
  assets: AssetService;
  stories: StoryService;
  preview: PreviewService;
}
