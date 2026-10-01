import os from "node:os";
import path from "node:path";
import { buildApp } from "./app.ts";

const dataDir = process.env.APPFORGE_HOME ?? path.join(os.homedir(), ".appforge");
const port = Number(process.env.APPFORGE_PORT ?? 4317);
const host = process.env.APPFORGE_HOST ?? "127.0.0.1";

const { app } = await buildApp({ dataDir, logger: process.env.APPFORGE_LOG === "1", demo: process.env.APPFORGE_DEMO === "1" || process.argv.includes("--demo") });

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received, shutting down…`);
  await app.close();
  process.exit(0);
};
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

await app.listen({ port, host });
console.log(`AppForge server on http://${host}:${port} (data: ${dataDir})`);
