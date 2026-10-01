import type { Orchestrator } from "@appforge/orchestrator";
import type { ProviderRegistry, SecretStore } from "@appforge/providers";
import type { ProjectTesting } from "@appforge/testing";
import type { ProcessRegistry } from "@appforge/workspace";
import type { Store } from "./db/store.ts";
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
}
