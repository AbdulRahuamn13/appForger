import path from "node:path";
import type { FastifyInstance } from "fastify";
import type { RunMode, UsageSummary } from "@appforge/core";
import { RUN_MODES } from "@appforge/core";
import type { Orchestrator } from "@appforge/orchestrator";
import { GitRepo } from "@appforge/workspace";
import type { AppContext } from "../context.ts";

export function runRoutes(app: FastifyInstance, ctx: AppContext, orchestrator: Orchestrator): void {
  const { store } = ctx;
  const guard = async <T>(fn: () => T | Promise<T>, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    try {
      return await fn();
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  };

  app.get<{ Params: { id: string } }>("/api/projects/:id/runs", async (req) => store.listRuns(req.params.id));

  app.post<{ Params: { id: string }; Body: { mode: RunMode; brief: string; repo?: string } }>("/api/projects/:id/runs", async (req, reply) => {
    const { mode, brief, repo } = req.body ?? ({} as never);
    if (!RUN_MODES.includes(mode)) return reply.code(400).send({ error: `mode must be one of ${RUN_MODES.join(", ")}` });
    return guard(() => {
      const run = orchestrator.startRun(req.params.id, { mode, brief, ...(repo ? { repo } : {}) });
      return reply.code(201).send(run);
    }, reply);
  });

  app.get<{ Params: { id: string } }>("/api/runs/:id", async (req, reply) => {
    const run = store.getRun(req.params.id);
    if (!run) return reply.code(404).send({ error: "Run not found" });
    return {
      run,
      project: store.getProject(run.projectId),
      tasks: store.listTasks(run.id),
      approvals: store.listApprovals(run.id),
      logs: store.listLogs(run.id),
      active: orchestrator.isActive(run.id),
    };
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string; limit?: string } }>("/api/runs/:id/events", async (req) =>
    store.listEvents(req.params.id, Number(req.query.after ?? 0), Math.min(Number(req.query.limit ?? 5000), 20_000)),
  );

  /** Tokens and cost per agent, summed from usage events. */
  app.get<{ Params: { id: string } }>("/api/runs/:id/usage", async (req) => {
    const byAgent = new Map<string, UsageSummary>();
    for (const { event } of store.listEvents(req.params.id, 0, 1_000_000)) {
      if (event.type !== "usage") continue;
      const u = byAgent.get(event.agentId) ?? { agentId: event.agentId, role: event.role, provider: event.provider, inputTokens: 0, outputTokens: 0, costUsd: 0 };
      u.inputTokens += event.inputTokens;
      u.outputTokens += event.outputTokens;
      u.costUsd += event.costUsd ?? 0;
      byAgent.set(event.agentId, u);
    }
    return [...byAgent.values()];
  });

  app.post<{ Params: { id: string } }>("/api/runs/:id/stop", async (req) => ({ stopped: orchestrator.stopRun(req.params.id) }));
  app.post<{ Params: { id: string } }>("/api/runs/:id/resume", async (req, reply) => guard(() => orchestrator.resumeRun(req.params.id), reply));
  app.post<{ Params: { id: string }; Body: { text: string } }>("/api/runs/:id/message", async (req, reply) =>
    guard(() => {
      if (!req.body?.text?.trim()) throw new Error("Message is empty");
      orchestrator.sendCommand(req.params.id, { kind: "message", text: req.body.text.trim() });
      return { ok: true };
    }, reply),
  );
  app.post<{ Params: { id: string } }>("/api/runs/:id/finish", async (req, reply) =>
    guard(() => {
      orchestrator.sendCommand(req.params.id, { kind: "finish" });
      return { ok: true };
    }, reply),
  );
  app.post<{ Params: { id: string } }>("/api/runs/:id/discard", async (req, reply) =>
    guard(() => {
      orchestrator.sendCommand(req.params.id, { kind: "discard" });
      return { ok: true };
    }, reply),
  );

  app.post<{ Params: { id: string }; Body: { approved: boolean; comment?: string } }>("/api/approvals/:id", async (req, reply) =>
    guard(() => orchestrator.decideApproval(req.params.id, Boolean(req.body?.approved), req.body?.comment), reply),
  );

  /** Per-file before/after contents for the Monaco diff view. */
  app.get<{ Params: { id: string } }>("/api/approvals/:id/diff", async (req, reply) => {
    const approval = store.getApproval(req.params.id);
    if (!approval) return reply.code(404).send({ error: "Approval not found" });
    const run = store.getRun(approval.runId);
    const project = run && store.getProject(run.projectId);
    if (!project) return reply.code(404).send({ error: "Project not found" });
    return guard(() => new GitRepo(path.join(project.path, approval.repo)).diffFiles(approval.baseBranch, approval.branch), reply);
  });

  app.get<{ Params: { id: string } }>("/api/tasks/:id/diff", async (req, reply) => {
    const task = store.getTask(req.params.id);
    if (!task?.branch) return reply.code(404).send({ error: "Task has no branch yet" });
    const run = store.getRun(task.runId);
    const project = run && store.getProject(run.projectId);
    if (!project || !run) return reply.code(404).send({ error: "Project not found" });
    const base = store.getRunState<{ baseBranches?: Record<string, string> }>(run.id)?.baseBranches?.[task.repo] ?? "main";
    return guard(() => new GitRepo(path.join(project.path, task.repo)).diffFiles(base, task.branch as string), reply);
  });

  /** Global kill switch. */
  app.post("/api/kill", async () => orchestrator.killAll());
}
