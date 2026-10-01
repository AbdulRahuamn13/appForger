import type Database from "better-sqlite3";

/**
 * Hand-written migrations matching schema.ts, applied in order and tracked
 * with PRAGMA user_version. Append new entries; never edit old ones.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL UNIQUE,
    shape TEXT NOT NULL,
    stack_id TEXT NOT NULL,
    repos TEXT NOT NULL,
    settings TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE runs (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    mode TEXT NOT NULL,
    brief TEXT NOT NULL,
    status TEXT NOT NULL,
    error TEXT,
    state TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    finished_at TEXT
  );
  CREATE INDEX runs_project_idx ON runs(project_id);
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    area TEXT NOT NULL,
    repo TEXT NOT NULL,
    status TEXT NOT NULL,
    depends_on TEXT NOT NULL,
    files TEXT NOT NULL,
    branch TEXT,
    worktree_path TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    review TEXT,
    test_reports TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX tasks_run_idx ON tasks(run_id);
  CREATE TABLE events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL,
    run_id TEXT NOT NULL,
    task_id TEXT,
    agent_id TEXT NOT NULL,
    role TEXT NOT NULL,
    provider TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE INDEX events_run_idx ON events(run_id);
  CREATE TABLE logs (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL,
    task_id TEXT,
    level TEXT NOT NULL,
    message TEXT NOT NULL,
    ts TEXT NOT NULL
  );
  CREATE INDEX logs_run_idx ON logs(run_id);
  CREATE TABLE approvals (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL,
    task_id TEXT,
    title TEXT NOT NULL,
    repo TEXT NOT NULL,
    branch TEXT NOT NULL,
    base_branch TEXT NOT NULL,
    status TEXT NOT NULL,
    comment TEXT,
    created_at TEXT NOT NULL,
    decided_at TEXT
  );
  CREATE INDEX approvals_run_idx ON approvals(run_id);
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
  // 2: stories (plan first, then execute), reference images, runs linked to stories
  `
  ALTER TABLE runs ADD COLUMN story_id TEXT;
  CREATE INDEX runs_story_idx ON runs(story_id);
  CREATE TABLE stories (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    acceptance TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    images TEXT NOT NULL DEFAULT '[]',
    plan TEXT,
    mode TEXT,
    plan_run_ids TEXT NOT NULL DEFAULT '[]',
    run_ids TEXT NOT NULL DEFAULT '[]',
    outcome TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX stories_project_idx ON stories(project_id);
  CREATE TABLE assets (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    media_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX assets_project_idx ON assets(project_id);
  `,
];

export function migrate(sqlite: Database.Database): void {
  const current = sqlite.pragma("user_version", { simple: true }) as number;
  for (let version = current; version < MIGRATIONS.length; version++) {
    const sql = MIGRATIONS[version] as string;
    sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.pragma(`user_version = ${version + 1}`);
    })();
  }
}
