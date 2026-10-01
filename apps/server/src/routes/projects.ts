import type { FastifyInstance } from "fastify";
import type { ProjectSettings } from "@appforge/core";
import { STACK_TEMPLATES } from "@appforge/templates";
import type { AppContext } from "../context.ts";
import { createProject, ProjectError, scaffoldProject, type CreateProjectInput } from "../projects.ts";

export function projectRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/stacks", async () =>
    STACK_TEMPLATES.map((s) => ({
      id: s.id,
      label: s.label,
      description: s.description,
      backend: { id: s.backend.id, label: s.backend.label, unitFrameworks: s.backend.unitFrameworks, defaultUnit: s.backend.defaultUnit },
      frontend: { id: s.frontend.id, label: s.frontend.label, unitFrameworks: s.frontend.unitFrameworks, defaultUnit: s.frontend.defaultUnit },
    })),
  );

  app.get("/api/projects", async () => ctx.store.listProjects());

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const project = ctx.store.getProject(req.params.id);
    return project ?? reply.code(404).send({ error: "Project not found" });
  });

  app.post<{ Body: CreateProjectInput }>("/api/projects", async (req, reply) => {
    try {
      const project = await createProject(req.body, ctx.store.listProjects());
      // Starter files come with the chosen test frameworks ready to run.
      if (req.body.scaffold && project.stackId !== "custom") await ctx.testing.scaffold(project);
      ctx.store.insertProject(project);
      ctx.hub.broadcast({ kind: "project-updated", project });
      return reply.code(201).send(project);
    } catch (err) {
      if (err instanceof ProjectError) return reply.code(400).send({ error: err.message });
      throw err;
    }
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; settings?: Partial<ProjectSettings> } }>(
    "/api/projects/:id",
    async (req, reply) => {
      const project = ctx.store.getProject(req.params.id);
      if (!project) return reply.code(404).send({ error: "Project not found" });
      if (req.body.name?.trim()) project.name = req.body.name.trim();
      const before = { ...project.settings };
      if (req.body.settings) {
        const s = req.body.settings;
        project.settings = {
          ...project.settings,
          ...s,
          roles: { ...project.settings.roles, ...(s.roles ?? {}) },
        };
        project.settings.concurrency = clamp(project.settings.concurrency, 1, 8);
        project.settings.maxFixLoops = clamp(project.settings.maxFixLoops, 0, 10);
      }
      ctx.store.updateProject(project);
      ctx.hub.broadcast({ kind: "project-updated", project });
      // Switching frameworks (e.g. Playwright → Cypress) scaffolds the new one right away.
      const layers: ("unit" | "e2e")[] = [];
      if (project.settings.e2e !== before.e2e) layers.push("e2e");
      if (project.settings.unitBackend !== before.unitBackend || project.settings.unitFrontend !== before.unitFrontend) layers.push("unit");
      let scaffolded: string[] = [];
      if (layers.length && project.stackId !== "custom" && !ctx.orchestrator.hasActiveRuns(project.id)) {
        scaffolded = await ctx.testing.scaffold(project, layers);
      }
      return { ...project, scaffolded };
    },
  );

  app.post<{ Params: { id: string } }>("/api/projects/:id/scaffold", async (req, reply) => {
    const project = ctx.store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return { written: await scaffoldProject(project) };
  });

  /** Optional: a GitHub Actions workflow running the same test commands. */
  app.post<{ Params: { id: string } }>("/api/projects/:id/ci", async (req, reply) => {
    const project = ctx.store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return { written: await ctx.testing.writeCiWorkflow(project) };
  });

  /** Forget the project (files on disk are left alone). */
  app.delete<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const project = ctx.store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    if (ctx.orchestrator.hasActiveRuns(project.id)) return reply.code(409).send({ error: "Stop the project's active runs first" });
    ctx.store.deleteProject(project.id);
    return { ok: true };
  });
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(Number.isFinite(n) ? n : min)));
}
