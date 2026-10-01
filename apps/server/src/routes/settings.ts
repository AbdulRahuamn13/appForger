import type { FastifyInstance } from "fastify";
import type { StorageSettings } from "@appforge/core";
import type { AppContext } from "../context.ts";
import { runDoctor } from "../doctor.ts";

export function settingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const credentialStatus = async () => ({
    accessKeyId: await ctx.secrets.status("s3-access-key-id"),
    secretAccessKey: await ctx.secrets.status("s3-secret-access-key"),
  });

  app.get("/api/settings/storage", async () => ({
    settings: ctx.storage.getSettings(),
    location: ctx.storage.store.describe(),
    active: ctx.storage.store.kind,
    credentials: await credentialStatus(),
  }));

  /**
   * Switch between local and cloud storage. Cloud keys go to the OS keychain.
   * The new location is tested first; `copy` moves existing skills, logs,
   * memory and images across.
   */
  app.put<{ Body: { settings: StorageSettings; credentials?: { accessKeyId?: string; secretAccessKey?: string }; copy?: boolean } }>(
    "/api/settings/storage",
    async (req, reply) => {
      try {
        const creds = req.body?.credentials;
        if (creds?.accessKeyId?.trim()) await ctx.secrets.set("s3-access-key-id", creds.accessKeyId);
        if (creds?.secretAccessKey?.trim()) await ctx.secrets.set("s3-secret-access-key", creds.secretAccessKey);
        const copied = await ctx.storage.switchTo(req.body.settings, { copy: Boolean(req.body?.copy) });
        return { settings: ctx.storage.getSettings(), location: ctx.storage.store.describe(), active: ctx.storage.store.kind, copied, credentials: await credentialStatus() };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    },
  );

  app.get("/api/doctor", async () => runDoctor(ctx.providers, ctx.secrets, ctx.storage));

  // ───── Live preview ─────
  app.get<{ Params: { id: string } }>("/api/projects/:id/preview", async (req) => ctx.preview.state(req.params.id));
  app.post<{ Params: { id: string } }>("/api/projects/:id/preview/start", async (req, reply) => {
    const project = ctx.store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return ctx.preview.start(project);
  });
  app.post<{ Params: { id: string } }>("/api/projects/:id/preview/stop", async (req) => ctx.preview.stop(req.params.id));
}
