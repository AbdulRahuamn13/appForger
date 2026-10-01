import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const projects = sqliteTable("projects", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  path: text("path").notNull().unique(),
  shape: text("shape").notNull(),
  stackId: text("stack_id").notNull(),
  repos: text("repos").notNull(),
  settings: text("settings").notNull(),
  createdAt: text("created_at").notNull(),
});

export const runs = sqliteTable(
  "runs",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    mode: text("mode").notNull(),
    storyId: text("story_id"),
    brief: text("brief").notNull(),
    status: text("status").notNull(),
    error: text("error"),
    /** Orchestrator checkpoint (JSON) used to resume after a restart. */
    state: text("state"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    finishedAt: text("finished_at"),
  },
  (t) => [index("runs_project_idx").on(t.projectId)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    title: text("title").notNull(),
    description: text("description").notNull(),
    area: text("area").notNull(),
    repo: text("repo").notNull(),
    status: text("status").notNull(),
    dependsOn: text("depends_on").notNull(),
    files: text("files").notNull(),
    branch: text("branch"),
    worktreePath: text("worktree_path"),
    attempts: integer("attempts").notNull().default(0),
    review: text("review"),
    testReports: text("test_reports"),
    order: integer("sort_order").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("tasks_run_idx").on(t.runId)],
);

export const events = sqliteTable(
  "events",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    id: text("id").notNull(),
    runId: text("run_id").notNull(),
    taskId: text("task_id"),
    agentId: text("agent_id").notNull(),
    role: text("role").notNull(),
    provider: text("provider").notNull(),
    type: text("type").notNull(),
    payload: text("payload").notNull(),
    ts: text("ts").notNull(),
  },
  (t) => [index("events_run_idx").on(t.runId)],
);

export const logs = sqliteTable(
  "logs",
  {
    seq: integer("seq").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    taskId: text("task_id"),
    level: text("level").notNull(),
    message: text("message").notNull(),
    ts: text("ts").notNull(),
  },
  (t) => [index("logs_run_idx").on(t.runId)],
);

export const approvals = sqliteTable(
  "approvals",
  {
    id: text("id").primaryKey(),
    runId: text("run_id").notNull(),
    taskId: text("task_id"),
    title: text("title").notNull(),
    repo: text("repo").notNull(),
    branch: text("branch").notNull(),
    baseBranch: text("base_branch").notNull(),
    status: text("status").notNull(),
    comment: text("comment"),
    createdAt: text("created_at").notNull(),
    decidedAt: text("decided_at"),
  },
  (t) => [index("approvals_run_idx").on(t.runId)],
);

/** Non-secret app settings (e.g. default models). API keys never go here. */
export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

export const stories = sqliteTable(
  "stories",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull(),
    acceptance: text("acceptance").notNull().default(""),
    status: text("status").notNull(),
    order: integer("sort_order").notNull().default(0),
    images: text("images").notNull().default("[]"),
    plan: text("plan"),
    mode: text("mode"),
    planRunIds: text("plan_run_ids").notNull().default("[]"),
    runIds: text("run_ids").notNull().default("[]"),
    outcome: text("outcome"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("stories_project_idx").on(t.projectId)],
);

export const assets = sqliteTable(
  "assets",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("assets_project_idx").on(t.projectId)],
);
