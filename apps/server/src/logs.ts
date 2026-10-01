import type { AgentEvent, Approval, LogFileInfo, Project, Run, RunLogEvent, Story, Task, UsageSummary } from "@appforge/core";
import { slugify } from "@appforge/core";
import { getText, type BlobStore } from "@appforge/storage";
import type { Store } from "./db/store.ts";
import type { Hub } from "./hub.ts";

const LOG_NAME = /^[\w.-]+\.txt$/;

export function summariseUsage(events: AgentEvent[]): UsageSummary[] {
  const byAgent = new Map<string, UsageSummary>();
  for (const e of events) {
    if (e.type !== "usage") continue;
    const u = byAgent.get(e.agentId) ?? { agentId: e.agentId, role: e.role, provider: e.provider, inputTokens: 0, outputTokens: 0, costUsd: 0 };
    u.inputTokens += e.inputTokens;
    u.outputTokens += e.outputTokens;
    u.costUsd += e.costUsd ?? 0;
    byAgent.set(e.agentId, u);
  }
  return [...byAgent.values()];
}

function indent(text: string, pad = "    "): string {
  return text
    .split("\n")
    .map((l) => (l ? pad + l : l))
    .join("\n");
}

function time(iso: string): string {
  return iso.slice(11, 19);
}

function formatEvent(e: AgentEvent): string {
  switch (e.type) {
    case "session-start":
      return `session started${e.model ? ` (${e.model})` : ""}`;
    case "text":
      return e.text.includes("\n") ? `says:\n${indent(e.text)}` : `says: ${e.text}`;
    case "thinking":
      return `thinks: ${e.text.slice(0, 600)}`;
    case "tool-call":
      return `→ ${e.tool} ${e.input.slice(0, 500)}`;
    case "tool-result":
      return `← ${e.isError ? "ERROR " : ""}${e.output.split("\n").slice(0, 8).join("\n      ").slice(0, 800)}`;
    case "file-change":
      return `✎ ${e.kind} ${e.path}`;
    case "command":
      return `$ ${e.command}${e.exitCode !== undefined ? ` (exit ${e.exitCode})` : ""}`;
    case "usage":
      return `tokens in ${e.inputTokens} / out ${e.outputTokens}${e.costUsd ? ` · $${e.costUsd.toFixed(4)}` : ""}`;
    case "warning":
      return `WARNING ${e.message}`;
    case "error":
      return `ERROR ${e.message}${e.rateLimited ? " (rate limited)" : ""}`;
    case "session-end":
      return `session ${e.status}`;
  }
}

/** The whole story of a run as plain text: what was asked, planned, built, reviewed, tested, and every step. */
export function formatRunLog(input: {
  project: Project;
  run: Run;
  story?: Story | undefined;
  tasks: Task[];
  approvals: Approval[];
  logs: RunLogEvent[];
  events: AgentEvent[];
  plan?: Story["plan"];
}): string {
  const { project, run, story, tasks, approvals, logs, events } = input;
  const lines: string[] = [];
  const h = (title: string) => lines.push("", title, "-".repeat(title.length));
  const started = new Date(run.createdAt);
  const finished = run.finishedAt ? new Date(run.finishedAt) : undefined;
  lines.push("AppForge run log", "================");
  lines.push(`Project:  ${project.name} (${project.path})`);
  if (story) lines.push(`Story:    ${story.title} [${story.id}]`);
  lines.push(`Run:      ${run.id}`, `Mode:     ${run.mode}`, `Status:   ${run.status}${run.error ? ` — ${run.error}` : ""}`);
  lines.push(`Started:  ${run.createdAt}`);
  if (finished) lines.push(`Finished: ${run.finishedAt}  (${Math.round((finished.getTime() - started.getTime()) / 1000)}s)`);

  h("Brief");
  lines.push(run.brief);
  if (story?.acceptance.trim()) {
    h("Acceptance criteria");
    lines.push(story.acceptance.trim());
  }
  const plan = input.plan;
  if (plan) {
    h(`Plan v${plan.version}${plan.edited ? " (edited by hand)" : ""}`);
    lines.push(plan.summary, "", plan.spec);
    if (plan.design) lines.push("", "Design:", plan.design);
    if (plan.questions.length) lines.push("", "Open questions:", ...plan.questions.map((q) => `- ${q}`));
    lines.push("", "Planned tasks:", ...plan.tasks.map((t) => `- ${t.key} (${t.area}): ${t.title}${t.dependsOn.length ? ` [after ${t.dependsOn.join(", ")}]` : ""}`));
  }

  if (tasks.length) {
    h("Tasks");
    for (const t of tasks) {
      lines.push(`[${t.status}] ${t.key} — ${t.title} (${t.area})${t.branch ? ` on ${t.branch}` : ""}${t.attempts ? `, ${t.attempts} fix loop(s)` : ""}`);
      if (t.review) {
        lines.push(`    Review: ${t.review.verdict}${t.review.summary ? ` — ${t.review.summary}` : ""}`);
        for (const i of t.review.issues) lines.push(`      - [${i.severity}] ${i.file ? `${i.file}${i.line ? `:${i.line}` : ""} ` : ""}${i.message}`);
      }
      for (const r of t.testReports ?? []) {
        lines.push(`    Tests: ${r.framework} ${r.layer} in ${r.cwd}: ${r.passed}/${r.total} passed${r.failed ? `, ${r.failed} failed` : ""}${r.error ? ` — ${r.error}` : ""}`);
        for (const c of r.cases.filter((x) => x.status === "failed").slice(0, 10)) lines.push(`      ✗ ${c.suite ? `${c.suite} › ` : ""}${c.name}: ${c.error?.message ?? ""}`);
      }
    }
  }
  if (approvals.length) {
    h("Approvals");
    for (const a of approvals) lines.push(`${a.status.padEnd(9)} ${a.title} (${a.branch} → ${a.baseBranch})${a.comment ? ` — "${a.comment}"` : ""}${a.decidedAt ? ` at ${a.decidedAt}` : ""}`);
  }
  const usage = summariseUsage(events);
  if (usage.length) {
    h("Usage");
    for (const u of usage) lines.push(`${u.agentId.padEnd(16)} ${u.provider.padEnd(12)} in ${String(u.inputTokens).padStart(9)}  out ${String(u.outputTokens).padStart(8)}  ${u.costUsd ? `$${u.costUsd.toFixed(4)}` : ""}`);
    const total = usage.reduce((s, u) => s + u.costUsd, 0);
    if (total) lines.push(`Total reported cost: $${total.toFixed(4)}`);
  }

  h("Timeline");
  const timeline = [
    ...logs.map((l) => ({ ts: l.ts, line: `${time(l.ts)} [appforge] ${l.level === "info" ? "" : `${l.level.toUpperCase()} `}${l.message}` })),
    ...events.map((e) => ({ ts: e.ts, line: `${time(e.ts)} [${e.agentId}] ${formatEvent(e)}` })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const t of timeline) lines.push(t.line);
  return `${lines.join("\n")}\n`;
}

/** Run logs saved as text files per project in the active storage, viewable and downloadable from the UI. */
export class LogService {
  constructor(
    private readonly db: Store,
    private readonly hub: Hub,
    private readonly store: () => BlobStore,
  ) {}

  private prefix(projectId: string): string {
    return `projects/${projectId}/logs/`;
  }

  fileName(run: Run, title: string): string {
    const d = new Date(run.createdAt);
    const stamp = `${d.toISOString().slice(0, 10)}_${d.toISOString().slice(11, 16).replace(":", "")}`;
    return `${stamp}_${run.mode}_${slugify(title, 40)}_${run.id.slice(-6)}.txt`;
  }

  /** Build and store the log file for a run. Returns its name. */
  async save(runId: string): Promise<string | undefined> {
    const run = this.db.getRun(runId);
    const project = run && this.db.getProject(run.projectId);
    if (!run || !project) return undefined;
    const story = run.storyId ? this.db.getStory(run.storyId) : undefined;
    const state = this.db.getRunState<{ plan?: Story["plan"] }>(run.id);
    const text = formatRunLog({
      project,
      run,
      story,
      tasks: this.db.listTasks(run.id),
      approvals: this.db.listApprovals(run.id),
      logs: this.db.listLogs(run.id, 100_000),
      events: this.db.listEvents(run.id, 0, 1_000_000).map((e) => e.event),
      ...(state?.plan ? { plan: state.plan } : {}),
    });
    const name = this.fileName(run, story?.title ?? run.brief.split("\n")[0] ?? "run");
    await this.store().put(this.prefix(project.id) + name, text, "text/plain; charset=utf-8");
    this.hub.broadcast({ kind: "log-saved", projectId: project.id, name });
    return name;
  }

  async list(projectId: string): Promise<LogFileInfo[]> {
    const items = await this.store().list(this.prefix(projectId));
    return items
      .map((b) => ({ name: b.key.slice(this.prefix(projectId).length), size: b.size, updatedAt: b.updatedAt }))
      .filter((f) => LOG_NAME.test(f.name))
      .sort((a, b) => b.name.localeCompare(a.name));
  }

  async get(projectId: string, name: string): Promise<string | undefined> {
    if (!LOG_NAME.test(name)) return undefined;
    return getText(this.store(), this.prefix(projectId) + name);
  }

  /** Every log of the project, oldest first, in one file. */
  async all(projectId: string): Promise<string> {
    const files = (await this.list(projectId)).reverse();
    const parts: string[] = [];
    for (const f of files) parts.push(`\n\n########## ${f.name} ##########\n\n${(await this.get(projectId, f.name)) ?? ""}`);
    return parts.join("").trimStart();
  }
}

/** Free-form project memory (decisions, conventions, gotchas) that every agent reads. */
export class MemoryService {
  constructor(private readonly store: () => BlobStore) {}

  private key(projectId: string): string {
    return `projects/${projectId}/memory.md`;
  }

  async get(projectId: string): Promise<string> {
    return (await getText(this.store(), this.key(projectId))) ?? "";
  }

  async set(projectId: string, text: string): Promise<void> {
    await this.store().put(this.key(projectId), text, "text/markdown; charset=utf-8");
  }

  async append(projectId: string, entry: string): Promise<void> {
    const current = await this.get(projectId);
    await this.set(projectId, `${current.trimEnd()}${current.trim() ? "\n\n" : "# Project memory\n\n"}${entry.trim()}\n`);
  }
}
