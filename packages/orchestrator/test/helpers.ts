import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentEvent, Approval, Project, Run, RunLogEvent, ServerMessage, Task } from "@appforge/core";
import { defaultProjectSettings, newId, nowIso } from "@appforge/core";
import { ProviderRegistry, ScriptedAdapter, type Script } from "@appforge/providers";
import { reposForShape } from "@appforge/templates";
import { GitRepo } from "@appforge/workspace";
import { Orchestrator, type OrchestratorStore, type TestingService } from "../src/index.ts";

export class MemoryStore implements OrchestratorStore {
  projects = new Map<string, Project>();
  runs = new Map<string, Run>();
  tasks = new Map<string, Task>();
  events: AgentEvent[] = [];
  logs: RunLogEvent[] = [];
  approvals = new Map<string, Approval>();
  states = new Map<string, unknown>();

  getProject(id: string) {
    return this.projects.get(id);
  }
  getRun(id: string) {
    return this.runs.get(id);
  }
  insertRun(run: Run) {
    this.runs.set(run.id, { ...run });
  }
  updateRun(run: Run) {
    this.runs.set(run.id, { ...run });
  }
  listRunsByStatus(statuses: Run["status"][]) {
    return [...this.runs.values()].filter((r) => statuses.includes(r.status));
  }
  listTasks(runId: string) {
    return [...this.tasks.values()].filter((t) => t.runId === runId).sort((a, b) => a.order - b.order);
  }
  getTask(id: string) {
    const t = this.tasks.get(id);
    return t ? structuredClone(t) : undefined;
  }
  upsertTask(task: Task) {
    this.tasks.set(task.id, structuredClone(task));
  }
  appendEvent(event: AgentEvent) {
    this.events.push(event);
  }
  appendLog(log: RunLogEvent) {
    this.logs.push(log);
  }
  upsertApproval(a: Approval) {
    this.approvals.set(a.id, { ...a });
  }
  getApproval(id: string) {
    const a = this.approvals.get(id);
    return a ? { ...a } : undefined;
  }
  listApprovals(runId: string) {
    return [...this.approvals.values()].filter((a) => a.runId === runId);
  }
  getRunState<T>(runId: string) {
    return structuredClone(this.states.get(runId)) as T | undefined;
  }
  setRunState(runId: string, state: unknown) {
    this.states.set(runId, structuredClone(state));
  }
}

export interface Harness {
  dir: string;
  project: Project;
  store: MemoryStore;
  messages: ServerMessage[];
  orchestrator: Orchestrator;
  adapter: ScriptedAdapter;
  cleanup: () => Promise<void>;
  /** Resolve when a message matching `predicate` is emitted. */
  next: (predicate: (m: ServerMessage) => boolean, timeoutMs?: number) => Promise<ServerMessage>;
}

export async function harness(
  script: Script,
  options: { shape?: Project["shape"]; settings?: Partial<Project["settings"]>; testing?: TestingService; providerId?: string; extraAdapters?: ScriptedAdapter[] } = {},
): Promise<Harness> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "appforge-orch-"));
  const shape = options.shape ?? "monorepo";
  const providerId = options.providerId ?? "scripted";
  const repos = reposForShape(shape);
  for (const r of repos) {
    const repo = await GitRepo.init(path.join(dir, r.path));
    await writeFile(path.join(dir, r.path, "README.md"), "# test\n");
    await repo.commitAll("readme");
  }
  const project: Project = {
    id: newId("prj"),
    name: "Test",
    path: dir,
    shape,
    stackId: "node-react",
    repos,
    settings: defaultProjectSettings({
      unitBackend: "none",
      unitFrontend: "none",
      e2e: "none",
      requireApproval: false,
      roles: {
        architect: { provider: providerId },
        coder: { provider: providerId },
        reviewer: { provider: providerId },
        "test-author": { provider: providerId },
        integrator: { provider: providerId },
      },
      ...options.settings,
    }),
    createdAt: nowIso(),
  };
  const store = new MemoryStore();
  store.projects.set(project.id, project);
  const messages: ServerMessage[] = [];
  const listeners = new Set<(m: ServerMessage) => void>();
  const adapter = new ScriptedAdapter(script, providerId, "Scripted");
  const orchestrator = new Orchestrator({
    store,
    providers: new ProviderRegistry([adapter, ...(options.extraAdapters ?? [])]),
    emit: (m) => {
      messages.push(m);
      for (const l of listeners) l(m);
    },
    ...(options.testing ? { testing: options.testing } : {}),
  });
  const next = (predicate: (m: ServerMessage) => boolean, timeoutMs = 15_000) =>
    new Promise<ServerMessage>((resolve, reject) => {
      const existing = messages.find(predicate);
      if (existing) return resolve(existing);
      const timer = setTimeout(() => reject(new Error("Timed out waiting for message")), timeoutMs);
      const l = (m: ServerMessage) => {
        if (!predicate(m)) return;
        clearTimeout(timer);
        listeners.delete(l);
        resolve(m);
      };
      listeners.add(l);
    });
  return { dir, project, store, messages, orchestrator, adapter, next, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export function planJson(tasks: { key: string; area?: string; dependsOn?: string[]; files?: string[] }[]): string {
  return (
    "Spec written.\n```json\n" +
    JSON.stringify({
      summary: "test plan",
      tasks: tasks.map((t) => ({ key: t.key, title: `Build ${t.key}`, description: `Do ${t.key}`, area: t.area ?? "backend", dependsOn: t.dependsOn ?? [], files: t.files ?? [] })),
    }) +
    "\n```"
  );
}

export const APPROVE = '```json\n{"verdict":"approve","issues":[],"summary":"looks good"}\n```';
export const REQUEST_CHANGES = '```json\n{"verdict":"request-changes","issues":[{"severity":"major","message":"handle the empty case","file":"x.ts"}]}\n```';

export function taskKey(prompt: string): string {
  return /^## (?:Task|Review the diff for task|Write tests for task): Build (\S+)/m.exec(prompt)?.[1] ?? "?";
}
