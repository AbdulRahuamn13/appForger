/** Agent roles. Each role is a prompt + tool permissions + a provider/model. */
export const ROLES = ["architect", "coder", "reviewer", "test-author", "integrator"] as const;
export type RoleId = (typeof ROLES)[number];

export const RUN_MODES = ["single", "pipeline", "swarm", "swarm-native"] as const;
export type RunMode = (typeof RUN_MODES)[number];

export type ProjectShape = "monorepo" | "separate";

export const E2E_FRAMEWORKS = ["playwright", "cypress", "none"] as const;
export type E2EFramework = (typeof E2E_FRAMEWORKS)[number];

export const UNIT_FRAMEWORKS = ["vitest", "jest", "xunit", "pytest", "none"] as const;
export type UnitFramework = (typeof UNIT_FRAMEWORKS)[number];

export type TestFramework = Exclude<E2EFramework | UnitFramework, "none">;

/** Which provider (and optionally model) runs a role. */
export interface RoleAssignment {
  provider: string;
  model?: string;
}

export interface ProjectSettings {
  e2e: E2EFramework;
  unitBackend: UnitFramework;
  unitFrontend: UnitFramework;
  roles: Record<RoleId, RoleAssignment>;
  /** Max agents running at once in swarm mode. */
  concurrency: number;
  /** Bounded review/test fix loops per task. */
  maxFixLoops: number;
  /** Pause for a human approve/reject before every merge. */
  requireApproval: boolean;
  /** Optional spend cap per run (USD, as reported by providers). */
  budgetUsd?: number;
}

export interface Project {
  id: string;
  name: string;
  /** Absolute, real path of the project folder. */
  path: string;
  shape: ProjectShape;
  stackId: string;
  /** Git repositories inside the project folder, relative paths ("." for a monorepo). */
  repos: RepoRef[];
  settings: ProjectSettings;
  createdAt: string;
}

export interface RepoRef {
  /** Path relative to the project folder. */
  path: string;
  area: TaskArea;
}

export type TaskArea = "backend" | "frontend" | "shared";

export type RunStatus =
  | "pending"
  | "running"
  | "awaiting-input"
  | "awaiting-approval"
  | "paused"
  | "interrupted"
  | "succeeded"
  | "failed"
  | "cancelled";

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled"];

export interface Run {
  id: string;
  projectId: string;
  mode: RunMode;
  brief: string;
  status: RunStatus;
  error?: string;
  createdAt: string;
  updatedAt: string;
  finishedAt?: string;
}

export const TASK_STATUSES = [
  "todo",
  "in-progress",
  "review",
  "changes-requested",
  "testing",
  "awaiting-approval",
  "ready-to-merge",
  "merged",
  "failed",
  "cancelled",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export interface Task {
  id: string;
  runId: string;
  /** Stable key the Architect uses for dependencies, e.g. "backend-api". */
  key: string;
  title: string;
  description: string;
  area: TaskArea;
  /** Repo (relative to project folder) this task changes. */
  repo: string;
  status: TaskStatus;
  /** Keys of tasks that must be merged before this one starts. */
  dependsOn: string[];
  /** Glob patterns this task owns (swarm file ownership). Empty = no restriction. */
  files: string[];
  branch?: string;
  worktreePath?: string;
  attempts: number;
  review?: ReviewResult;
  testReports?: TestReport[];
  /** Order the Architect listed tasks in. */
  order: number;
  createdAt: string;
  updatedAt: string;
}

export type ReviewSeverity = "blocker" | "major" | "minor" | "nit";

export interface ReviewIssue {
  severity: ReviewSeverity;
  message: string;
  file?: string;
  line?: number;
}

export interface ReviewResult {
  verdict: "approve" | "request-changes";
  issues: ReviewIssue[];
  summary?: string;
}

export type TestLayer = "unit" | "e2e";

export interface TestCaseResult {
  name: string;
  suite?: string;
  file?: string;
  status: "passed" | "failed" | "skipped";
  durationMs?: number;
  error?: { message: string; stack?: string };
  /** Trace/screenshot/video paths, relative to the repo. */
  attachments?: string[];
}

export interface TestReport {
  framework: TestFramework;
  layer: TestLayer;
  /** Repo-relative directory the runner ran in. */
  cwd: string;
  startedAt: string;
  durationMs: number;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  cases: TestCaseResult[];
  /** Set when the runner itself could not run or its output could not be parsed. */
  error?: string;
  /** Tail of the runner's console output, for diagnostics. */
  outputTail?: string;
}

export type ApprovalStatus = "pending" | "approved" | "rejected";

export interface Approval {
  id: string;
  runId: string;
  taskId?: string;
  title: string;
  repo: string;
  branch: string;
  baseBranch: string;
  status: ApprovalStatus;
  comment?: string;
  createdAt: string;
  decidedAt?: string;
}

export interface FileDiff {
  path: string;
  oldPath?: string;
  status: "added" | "modified" | "deleted" | "renamed";
  before: string;
  after: string;
}

export interface UsageSummary {
  agentId: string;
  role: RoleId;
  provider: string;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
