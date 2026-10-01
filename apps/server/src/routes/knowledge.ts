import type { FastifyInstance } from "fastify";
import type { RoleId } from "@appforge/core";
import { parseSkillMarkdown } from "@appforge/storage";
import type { AppContext } from "../context.ts";

/** Logs, project memory, reference images and skills. */
export function knowledgeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const fail = (reply: { code(n: number): { send(b: unknown): unknown } }, err: unknown) => reply.code(400).send({ error: (err as Error).message });

  // ───── Logs ─────
  app.get<{ Params: { id: string } }>("/api/projects/:id/logs", async (req) => ctx.logs.list(req.params.id));

  app.get<{ Params: { id: string } }>("/api/projects/:id/logs-all", async (req, reply) => {
    const project = ctx.store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    const text = await ctx.logs.all(project.id);
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", `attachment; filename="${project.name.replace(/[^\w.-]+/g, "_")}-all-logs.txt"`)
      .send(text);
  });

  app.get<{ Params: { id: string; name: string }; Querystring: { download?: string } }>("/api/projects/:id/logs/:name", async (req, reply) => {
    const text = await ctx.logs.get(req.params.id, req.params.name);
    if (text === undefined) return reply.code(404).send({ error: "Log not found" });
    reply.header("content-type", "text/plain; charset=utf-8");
    if (req.query.download === "1") reply.header("content-disposition", `attachment; filename="${req.params.name}"`);
    return reply.send(text);
  });

  /** Re-generate a run's log file (e.g. for a run that is still going). */
  app.post<{ Params: { id: string } }>("/api/runs/:id/log", async (req, reply) => {
    const name = await ctx.logs.save(req.params.id);
    return name ? { name } : reply.code(404).send({ error: "Run not found" });
  });

  // ───── Memory ─────
  app.get<{ Params: { id: string } }>("/api/projects/:id/memory", async (req) => ({ text: await ctx.memory.get(req.params.id) }));
  app.put<{ Params: { id: string }; Body: { text: string } }>("/api/projects/:id/memory", async (req, reply) => {
    if (!ctx.store.getProject(req.params.id)) return reply.code(404).send({ error: "Project not found" });
    await ctx.memory.set(req.params.id, String(req.body?.text ?? ""));
    return { ok: true };
  });

  // ───── Reference images ─────
  app.post<{ Params: { id: string }; Body: { name: string; mediaType: string; dataBase64: string } }>("/api/projects/:id/assets", async (req, reply) => {
    if (!ctx.store.getProject(req.params.id)) return reply.code(404).send({ error: "Project not found" });
    try {
      const { name, mediaType, dataBase64 } = req.body ?? ({} as never);
      return reply.code(201).send(await ctx.assets.create(req.params.id, String(name ?? "image"), String(mediaType ?? ""), Buffer.from(String(dataBase64 ?? ""), "base64")));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    const asset = ctx.store.getAsset(req.params.id);
    const bytes = asset && (await ctx.assets.read(asset));
    if (!asset || !bytes) return reply.code(404).send({ error: "Image not found" });
    return reply.header("content-type", asset.mediaType).header("cache-control", "private, max-age=86400").send(bytes);
  });

  app.delete<{ Params: { id: string } }>("/api/assets/:id", async (req, reply) => {
    const asset = ctx.store.getAsset(req.params.id);
    if (!asset) return reply.code(404).send({ error: "Image not found" });
    await ctx.assets.delete(asset);
    return { ok: true };
  });

  // ───── Skills ─────
  type SkillBody = { name: string; description?: string; roles?: RoleId[]; default?: boolean; body: string };
  const toInput = (b: SkillBody, id?: string) => ({
    ...(id ? { id } : {}),
    name: String(b?.name ?? ""),
    description: String(b?.description ?? ""),
    roles: Array.isArray(b?.roles) ? b.roles : [],
    default: b?.default ?? true,
    body: String(b?.body ?? ""),
  });

  app.get("/api/skills", async () => ctx.storage.skills.list());

  app.get<{ Params: { id: string } }>("/api/skills/:id", async (req, reply) => (await ctx.storage.skills.get(req.params.id)) ?? reply.code(404).send({ error: "Skill not found" }));

  app.post<{ Body: SkillBody }>("/api/skills", async (req, reply) => {
    try {
      return reply.code(201).send(await ctx.storage.skills.save(toInput(req.body)));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.put<{ Params: { id: string }; Body: SkillBody }>("/api/skills/:id", async (req, reply) => {
    try {
      return await ctx.storage.skills.save(toInput(req.body, req.params.id));
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/skills/:id", async (req) => {
    await ctx.storage.skills.delete(req.params.id);
    return { ok: true };
  });

  /** Import from a folder on this machine (a skill, or a folder of skills like ~/.claude/skills) or pasted SKILL.md text. */
  app.post<{ Body: { path?: string; markdown?: string } }>("/api/skills/import", async (req, reply) => {
    try {
      if (req.body?.path) return { imported: await ctx.storage.skills.importFromPath(req.body.path) };
      if (req.body?.markdown) {
        const parsed = parseSkillMarkdown(req.body.markdown);
        return { imported: [await ctx.storage.skills.save(parsed)] };
      }
      return reply.code(400).send({ error: "Give a folder path or SKILL.md text" });
    } catch (err) {
      return fail(reply, err);
    }
  });
}
