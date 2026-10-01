import { mkdirSync } from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { AgentEvent, Approval, Asset, Project, Run, RunLogEvent, RunStatus, Story, Task } from "@appforge/core";
import { migrate } from "./migrations.ts";
import * as schema from "./schema.ts";

type ProjectRow = typeof schema.projects.$inferSelect;
type RunRow = typeof schema.runs.$inferSelect;
type TaskRow = typeof schema.tasks.$inferSelect;
type ApprovalRow = typeof schema.approvals.$inferSelect;
type StoryRow = typeof schema.stories.$inferSelect;
type AssetRow = typeof schema.assets.$inferSelect;

function toStory(row: StoryRow): Story {
  const story: Story = {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    body: row.body,
    acceptance: row.acceptance,
    status: row.status as Story["status"],
    order: row.order,
    images: parse(row.images, []),
    planRunIds: parse(row.planRunIds, []),
    runIds: parse(row.runIds, []),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.plan) story.plan = parse(row.plan, undefined);
  if (row.mode) story.mode = row.mode as Story["mode"];
  if (row.outcome) story.outcome = row.outcome;
  return story;
}

function toAsset(row: AssetRow): Asset {
  return { id: row.id, projectId: row.projectId, name: row.name, mediaType: row.mediaType, size: row.size, createdAt: row.createdAt };
}

const parse = <T>(text: string | null | undefined, fallback: T): T => {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
};

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    path: row.path,
    shape: row.shape as Project["shape"],
    stackId: row.stackId,
    repos: parse(row.repos, []),
    settings: parse(row.settings, {} as Project["settings"]),
    createdAt: row.createdAt,
  };
}

function toRun(row: RunRow): Run {
  const run: Run = {
    id: row.id,
    projectId: row.projectId,
    mode: row.mode as Run["mode"],
    brief: row.brief,
    status: row.status as RunStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.error) run.error = row.error;
  if (row.finishedAt) run.finishedAt = row.finishedAt;
  if (row.storyId) run.storyId = row.storyId;
  return run;
}

function toTask(row: TaskRow): Task {
  const task: Task = {
    id: row.id,
    runId: row.runId,
    key: row.key,
    title: row.title,
    description: row.description,
    area: row.area as Task["area"],
    repo: row.repo,
    status: row.status as Task["status"],
    dependsOn: parse(row.dependsOn, []),
    files: parse(row.files, []),
    attempts: row.attempts,
    order: row.order,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  if (row.branch) task.branch = row.branch;
  if (row.worktreePath) task.worktreePath = row.worktreePath;
  if (row.review) task.review = parse(row.review, undefined);
  if (row.testReports) task.testReports = parse(row.testReports, []);
  return task;
}

function toApproval(row: ApprovalRow): Approval {
  const a: Approval = {
    id: row.id,
    runId: row.runId,
    title: row.title,
    repo: row.repo,
    branch: row.branch,
    baseBranch: row.baseBranch,
    status: row.status as Approval["status"],
    createdAt: row.createdAt,
  };
  if (row.taskId) a.taskId = row.taskId;
  if (row.comment) a.comment = row.comment;
  if (row.decidedAt) a.decidedAt = row.decidedAt;
  return a;
}

export interface StoredEvent {
  seq: number;
  event: AgentEvent;
}

/** All persistence for the server. Synchronous under the hood (better-sqlite3). */
export class Store {
  readonly db: BetterSQLite3Database<typeof schema>;
  private readonly sqlite: Database.Database;

  constructor(file: string) {
    if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
    this.sqlite = new Database(file);
    this.sqlite.pragma("journal_mode = WAL");
    this.sqlite.pragma("foreign_keys = ON");
    migrate(this.sqlite);
    this.db = drizzle(this.sqlite, { schema });
  }

  close(): void {
    this.sqlite.close();
  }

  // Projects
  listProjects(): Project[] {
    return this.db.select().from(schema.projects).orderBy(desc(schema.projects.createdAt)).all().map(toProject);
  }

  getProject(id: string): Project | undefined {
    const row = this.db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
    return row ? toProject(row) : undefined;
  }

  getProjectByPath(p: string): Project | undefined {
    const row = this.db.select().from(schema.projects).where(eq(schema.projects.path, p)).get();
    return row ? toProject(row) : undefined;
  }

  insertProject(project: Project): void {
    this.db
      .insert(schema.projects)
      .values({
        id: project.id,
        name: project.name,
        path: project.path,
        shape: project.shape,
        stackId: project.stackId,
        repos: JSON.stringify(project.repos),
        settings: JSON.stringify(project.settings),
        createdAt: project.createdAt,
      })
      .run();
  }

  updateProject(project: Project): void {
    this.db
      .update(schema.projects)
      .set({ name: project.name, settings: JSON.stringify(project.settings), stackId: project.stackId })
      .where(eq(schema.projects.id, project.id))
      .run();
  }

  deleteProject(id: string): void {
    const runIds = this.db.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.projectId, id)).all().map((r) => r.id);
    this.sqlite.transaction(() => {
      if (runIds.length) {
        this.db.delete(schema.events).where(inArray(schema.events.runId, runIds)).run();
        this.db.delete(schema.logs).where(inArray(schema.logs.runId, runIds)).run();
        this.db.delete(schema.approvals).where(inArray(schema.approvals.runId, runIds)).run();
      }
      this.db.delete(schema.projects).where(eq(schema.projects.id, id)).run();
    })();
  }

  // Runs
  listRuns(projectId: string): Run[] {
    return this.db.select().from(schema.runs).where(eq(schema.runs.projectId, projectId)).orderBy(desc(schema.runs.createdAt)).all().map(toRun);
  }

  listRunsByStatus(statuses: RunStatus[]): Run[] {
    return this.db.select().from(schema.runs).where(inArray(schema.runs.status, statuses)).all().map(toRun);
  }

  getRun(id: string): Run | undefined {
    const row = this.db.select().from(schema.runs).where(eq(schema.runs.id, id)).get();
    return row ? toRun(row) : undefined;
  }

  insertRun(run: Run): void {
    this.db
      .insert(schema.runs)
      .values({
        id: run.id,
        projectId: run.projectId,
        mode: run.mode,
        storyId: run.storyId ?? null,
        brief: run.brief,
        status: run.status,
        error: run.error ?? null,
        createdAt: run.createdAt,
        updatedAt: run.updatedAt,
        finishedAt: run.finishedAt ?? null,
      })
      .run();
  }

  updateRun(run: Run): void {
    this.db
      .update(schema.runs)
      .set({ status: run.status, error: run.error ?? null, updatedAt: run.updatedAt, finishedAt: run.finishedAt ?? null })
      .where(eq(schema.runs.id, run.id))
      .run();
  }

  getRunState<T>(runId: string): T | undefined {
    const row = this.db.select({ state: schema.runs.state }).from(schema.runs).where(eq(schema.runs.id, runId)).get();
    return row?.state ? parse<T | undefined>(row.state, undefined) : undefined;
  }

  setRunState(runId: string, state: unknown): void {
    this.db.update(schema.runs).set({ state: JSON.stringify(state) }).where(eq(schema.runs.id, runId)).run();
  }

  // Tasks
  listTasks(runId: string): Task[] {
    return this.db.select().from(schema.tasks).where(eq(schema.tasks.runId, runId)).orderBy(asc(schema.tasks.order)).all().map(toTask);
  }

  getTask(id: string): Task | undefined {
    const row = this.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
    return row ? toTask(row) : undefined;
  }

  upsertTask(task: Task): void {
    const values = {
      id: task.id,
      runId: task.runId,
      key: task.key,
      title: task.title,
      description: task.description,
      area: task.area,
      repo: task.repo,
      status: task.status,
      dependsOn: JSON.stringify(task.dependsOn),
      files: JSON.stringify(task.files),
      branch: task.branch ?? null,
      worktreePath: task.worktreePath ?? null,
      attempts: task.attempts,
      review: task.review ? JSON.stringify(task.review) : null,
      testReports: task.testReports ? JSON.stringify(task.testReports) : null,
      order: task.order,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
    };
    const { id: _id, createdAt: _c, ...updates } = values;
    this.db.insert(schema.tasks).values(values).onConflictDoUpdate({ target: schema.tasks.id, set: updates }).run();
  }

  // Events & logs
  appendEvent(event: AgentEvent): number {
    const { id, runId, taskId, agentId, role, provider, ts, type } = event;
    const result = this.db
      .insert(schema.events)
      .values({ id, runId, taskId: taskId ?? null, agentId, role, provider, type, ts, payload: JSON.stringify(event) })
      .run();
    return Number(result.lastInsertRowid);
  }

  listEvents(runId: string, afterSeq = 0, limit = 5_000): StoredEvent[] {
    return this.db
      .select()
      .from(schema.events)
      .where(and(eq(schema.events.runId, runId), gt(schema.events.seq, afterSeq)))
      .orderBy(asc(schema.events.seq))
      .limit(limit)
      .all()
      .map((row) => ({ seq: row.seq, event: JSON.parse(row.payload) as AgentEvent }));
  }

  appendLog(log: RunLogEvent): void {
    this.db
      .insert(schema.logs)
      .values({ runId: log.runId, taskId: log.taskId ?? null, level: log.level, message: log.message, ts: log.ts })
      .run();
  }

  listLogs(runId: string, limit = 2_000): RunLogEvent[] {
    return this.db
      .select()
      .from(schema.logs)
      .where(eq(schema.logs.runId, runId))
      .orderBy(asc(schema.logs.seq))
      .limit(limit)
      .all()
      .map((r) => {
        const log: RunLogEvent = { runId: r.runId, level: r.level as RunLogEvent["level"], message: r.message, ts: r.ts };
        if (r.taskId) log.taskId = r.taskId;
        return log;
      });
  }

  // Approvals
  upsertApproval(a: Approval): void {
    const values = {
      id: a.id,
      runId: a.runId,
      taskId: a.taskId ?? null,
      title: a.title,
      repo: a.repo,
      branch: a.branch,
      baseBranch: a.baseBranch,
      status: a.status,
      comment: a.comment ?? null,
      createdAt: a.createdAt,
      decidedAt: a.decidedAt ?? null,
    };
    this.db
      .insert(schema.approvals)
      .values(values)
      .onConflictDoUpdate({ target: schema.approvals.id, set: { status: values.status, comment: values.comment, decidedAt: values.decidedAt } })
      .run();
  }

  getApproval(id: string): Approval | undefined {
    const row = this.db.select().from(schema.approvals).where(eq(schema.approvals.id, id)).get();
    return row ? toApproval(row) : undefined;
  }

  listApprovals(runId: string): Approval[] {
    return this.db.select().from(schema.approvals).where(eq(schema.approvals.runId, runId)).orderBy(asc(schema.approvals.createdAt)).all().map(toApproval);
  }

  // Stories
  listStories(projectId: string): Story[] {
    return this.db.select().from(schema.stories).where(eq(schema.stories.projectId, projectId)).orderBy(asc(schema.stories.order), asc(schema.stories.createdAt)).all().map(toStory);
  }

  getStory(id: string): Story | undefined {
    const row = this.db.select().from(schema.stories).where(eq(schema.stories.id, id)).get();
    return row ? toStory(row) : undefined;
  }

  upsertStory(story: Story): void {
    const values = {
      id: story.id,
      projectId: story.projectId,
      title: story.title,
      body: story.body,
      acceptance: story.acceptance,
      status: story.status,
      order: story.order,
      images: JSON.stringify(story.images),
      plan: story.plan ? JSON.stringify(story.plan) : null,
      mode: story.mode ?? null,
      planRunIds: JSON.stringify(story.planRunIds),
      runIds: JSON.stringify(story.runIds),
      outcome: story.outcome ?? null,
      createdAt: story.createdAt,
      updatedAt: story.updatedAt,
    };
    const { id: _id, createdAt: _c, projectId: _p, ...updates } = values;
    this.db.insert(schema.stories).values(values).onConflictDoUpdate({ target: schema.stories.id, set: updates }).run();
  }

  deleteStory(id: string): void {
    this.db.delete(schema.stories).where(eq(schema.stories.id, id)).run();
  }

  listRunsForStory(storyId: string): Run[] {
    return this.db.select().from(schema.runs).where(eq(schema.runs.storyId, storyId)).orderBy(asc(schema.runs.createdAt)).all().map(toRun);
  }

  // Assets (metadata; bytes live in the storage backend)
  insertAsset(asset: Asset): void {
    this.db.insert(schema.assets).values(asset).run();
  }

  getAsset(id: string): Asset | undefined {
    const row = this.db.select().from(schema.assets).where(eq(schema.assets.id, id)).get();
    return row ? toAsset(row) : undefined;
  }

  deleteAsset(id: string): void {
    this.db.delete(schema.assets).where(eq(schema.assets.id, id)).run();
  }

  // Settings (non-secret)
  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.select().from(schema.settings).where(eq(schema.settings.key, key)).get();
    return row ? parse(row.value, fallback) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    const text = JSON.stringify(value);
    this.db.insert(schema.settings).values({ key, value: text }).onConflictDoUpdate({ target: schema.settings.key, set: { value: text } }).run();
  }
}
