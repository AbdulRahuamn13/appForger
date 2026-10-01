import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify, { type FastifyInstance } from "fastify";
import { Orchestrator, type TestingService } from "@appforge/orchestrator";
import { createDefaultRegistry, KeychainSecretStore, type ProviderRegistry, type SecretStore } from "@appforge/providers";
import { ProjectTesting } from "@appforge/testing";
import { ProcessRegistry } from "@appforge/workspace";
import type { BlobStore } from "@appforge/storage";
import { AssetService } from "./assets.ts";
import type { AppContext } from "./context.ts";
import { ProjectContextProvider } from "./context-provider.ts";
import { LogService, MemoryService } from "./logs.ts";
import { PreviewService } from "./preview.ts";
import { knowledgeRoutes } from "./routes/knowledge.ts";
import { settingsRoutes } from "./routes/settings.ts";
import { storyRoutes } from "./routes/stories.ts";
import { StorageManager } from "./storage.ts";
import { StoryService } from "./stories.ts";
import { Store } from "./db/store.ts";
import { Hub } from "./hub.ts";
import { fsRoutes } from "./routes/fs.ts";
import { projectRoutes } from "./routes/projects.ts";
import { providerRoutes } from "./routes/providers.ts";
import { runRoutes } from "./routes/runs.ts";

export interface BuildOptions {
  dataDir: string;
  /** SQLite file; defaults to <dataDir>/appforge.db. Use ":memory:" in tests. */
  dbFile?: string;
  /** Serve the built UI from this folder if it exists. */
  webDist?: string;
  logger?: boolean;
  secrets?: SecretStore;
  providers?: ProviderRegistry;
  /** Register the free "demo" provider (canned output) for trying runs without an account. */
  demo?: boolean;
  testing?: TestingService;
  /** Replace the storage backend (tests). */
  blobStore?: BlobStore;
}

export interface Built {
  app: FastifyInstance;
  ctx: AppContext;
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export async function buildApp(options: BuildOptions): Promise<Built> {
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: 25 * 1024 * 1024 });
  const store = new Store(options.dbFile ?? path.join(options.dataDir, "appforge.db"));
  const hub = new Hub();
  const secrets = options.secrets ?? new KeychainSecretStore();
  const providers = options.providers ?? createDefaultRegistry(secrets, { demo: options.demo ?? false });
  const processes = new ProcessRegistry();
  const testing = new ProjectTesting(processes);
  const storage = await StorageManager.create(store, secrets, options.dataDir, options.blobStore);
  const logs = new LogService(store, hub, () => storage.store);
  const memory = new MemoryService(() => storage.store);
  const assets = new AssetService(store, () => storage.store);
  // Stories and the orchestrator reference each other: the hooks are bound once both exist.
  const late: { stories?: StoryService } = {};
  const orchestrator = new Orchestrator({
    store,
    providers,
    emit: (m) => hub.broadcast(m),
    processes,
    testing: options.testing ?? testing,
    context: new ProjectContextProvider(store, storage, logs, memory, assets),
    hooks: {
      onPlanReady: (run, plan) => late.stories?.onPlanReady(run, plan),
      onRunFinished: (run) => late.stories?.onRunFinished(run),
    },
  });
  const stories = new StoryService(store, hub, () => orchestrator, logs, memory);
  late.stories = stories;
  const preview = new PreviewService(testing, hub);
  const interrupted = orchestrator.recover();
  if (interrupted) app.log.info(`${interrupted} run(s) were interrupted by a restart; resume them from the UI`);
  const ctx: AppContext = { store, hub, dataDir: options.dataDir, providers, secrets, processes, testing, orchestrator, storage, logs, memory, assets, stories, preview };

  // AppForge runs commands on this machine: only answer local pages, which
  // blocks DNS-rebinding and cross-site requests from other origins.
  app.addHook("onRequest", async (req, reply) => {
    const host = (req.headers.host ?? "").replace(/:\d+$/, "");
    if (host && !LOCAL_HOSTS.has(host)) return reply.code(403).send({ error: "AppForge only serves localhost" });
    const origin = req.headers.origin;
    if (origin) {
      try {
        if (!LOCAL_HOSTS.has(new URL(origin).hostname)) {
          return reply.code(403).send({ error: "Cross-origin requests are not allowed" });
        }
      } catch {
        return reply.code(403).send({ error: "Bad origin" });
      }
    }
  });

  app.addHook("onClose", async () => {
    ctx.orchestrator.killAll();
    await preview.stopAll();
    store.close();
  });

  await app.register(fastifyWebsocket);
  app.get("/ws", { websocket: true }, (socket) => hub.add(socket));

  app.get("/api/health", async () => ({ ok: true }));
  fsRoutes(app);
  projectRoutes(app, ctx);
  providerRoutes(app, ctx);
  runRoutes(app, ctx, orchestrator);
  storyRoutes(app, ctx);
  knowledgeRoutes(app, ctx);
  settingsRoutes(app, ctx);

  const webDist = options.webDist ?? defaultWebDist();
  if (existsSync(path.join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.url.startsWith("/api/") || req.url === "/ws") return reply.code(404).send({ error: "Not found" });
      return reply.sendFile("index.html");
    });
  }

  return { app, ctx };
}

function defaultWebDist(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../web/dist");
}
