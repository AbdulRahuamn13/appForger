import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { AgentSession, AuthStatus } from "@appforge/core";
import { newId } from "@appforge/core";
import { runTurn, SECRET_NAMES, type SecretName } from "@appforge/providers";
import { checkCommand } from "@appforge/workspace";
import type { AppContext } from "../context.ts";

const STATUS_TTL_MS = 30_000;

export function providerRoutes(app: FastifyInstance, ctx: AppContext): void {
  let cache: { at: number; statuses: Record<string, AuthStatus> } | undefined;
  const playgrounds = new Map<string, AgentSession>();

  app.get<{ Querystring: { refresh?: string } }>("/api/providers", async (req) => {
    if (!cache || req.query.refresh === "1" || Date.now() - cache.at > STATUS_TTL_MS) {
      cache = { at: Date.now(), statuses: await ctx.providers.statuses() };
    }
    const statuses = cache.statuses;
    return ctx.providers.list().map((p) => ({
      id: p.id,
      label: p.label,
      vendor: p.vendor,
      authKind: p.authKind,
      models: p.models,
      defaultModel: p.defaultModel,
      status: statuses[p.id],
    }));
  });

  // API keys: write-only from the UI's point of view. Values are never returned or logged.
  app.get("/api/secrets", async () => {
    const out: Record<string, unknown> = {};
    for (const name of SECRET_NAMES) out[name] = await ctx.secrets.status(name);
    return out;
  });

  app.put<{ Params: { name: string }; Body: { value: string } }>("/api/secrets/:name", async (req, reply) => {
    const name = req.params.name as SecretName;
    if (!SECRET_NAMES.includes(name)) return reply.code(404).send({ error: "Unknown secret" });
    try {
      await ctx.secrets.set(name, String(req.body?.value ?? ""));
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    cache = undefined;
    return { ok: true, status: await ctx.secrets.status(name) };
  });

  app.delete<{ Params: { name: string } }>("/api/secrets/:name", async (req, reply) => {
    const name = req.params.name as SecretName;
    if (!SECRET_NAMES.includes(name)) return reply.code(404).send({ error: "Unknown secret" });
    await ctx.secrets.delete(name);
    cache = undefined;
    return { ok: true, status: await ctx.secrets.status(name) };
  });

  /**
   * Playground: send one prompt through a provider and stream the events to
   * the UI. Runs read-only inside a project folder, or with full access in a
   * scratch folder under the data dir.
   */
  app.post<{ Body: { provider: string; model?: string; prompt: string; projectId?: string } }>("/api/playground", async (req, reply) => {
    const { provider: providerId, model, prompt, projectId } = req.body ?? ({} as never);
    if (!providerId || !prompt?.trim()) return reply.code(400).send({ error: "provider and prompt are required" });
    if (!ctx.providers.has(providerId)) return reply.code(404).send({ error: `Unknown provider ${providerId}` });
    let cwd: string;
    let readOnly = false;
    if (projectId) {
      const project = ctx.store.getProject(projectId);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      cwd = project.path;
      readOnly = true;
    } else {
      cwd = path.join(ctx.dataDir, "playground");
      await mkdir(cwd, { recursive: true });
    }
    const id = newId("pg");
    let session: AgentSession;
    try {
      session = await ctx.providers.get(providerId).startSession({
        cwd,
        role: "coder",
        systemPrompt: "You are being tested from the AppForge Providers page. Answer briefly.",
        access: readOnly ? { mode: "read-only", shell: true } : { mode: "full", shell: true },
        maxTurns: 10,
        checkCommand: (c) => {
          const r = checkCommand(c, cwd);
          return r.ok ? undefined : r.reason;
        },
        ...(model ? { model } : {}),
      });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    playgrounds.set(id, session);
    void runTurn(session, prompt, (payload) => ctx.hub.broadcast({ kind: "playground-event", playgroundId: id, payload }))
      .catch((err: Error) =>
        ctx.hub.broadcast({ kind: "playground-event", playgroundId: id, payload: { type: "session-end", status: "failed", result: err.message } }),
      )
      .finally(() => playgrounds.delete(id));
    return { id, cwd };
  });

  app.post<{ Params: { id: string } }>("/api/playground/:id/stop", async (req) => {
    await playgrounds.get(req.params.id)?.stop();
    return { ok: true };
  });
}
