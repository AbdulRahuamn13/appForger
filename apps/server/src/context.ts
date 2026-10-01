import type { ProviderRegistry, SecretStore } from "@appforge/providers";
import type { Store } from "./db/store.ts";
import type { Hub } from "./hub.ts";

/** The subset of the run controller other routes need. */
export interface RunControl {
  hasActiveRuns(projectId: string): boolean;
}

export interface AppContext {
  store: Store;
  hub: Hub;
  dataDir: string;
  providers: ProviderRegistry;
  secrets: SecretStore;
  orchestrator?: RunControl;
}
