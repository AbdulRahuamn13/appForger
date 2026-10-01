import type {
  AgentEvent,
  RoleId,
  StoryPlan,
  Approval,
  Project,
  Run,
  RunLogEvent,
  ServerMessage,
  Task,
  TaskArea,
  TestReport,
} from "@appforge/core";

/** Persistence the orchestrator needs; the server's SQLite store implements it. */
export interface OrchestratorStore {
  getProject(id: string): Project | undefined;
  getRun(id: string): Run | undefined;
  insertRun(run: Run): void;
  updateRun(run: Run): void;
  listRunsByStatus(statuses: Run["status"][]): Run[];
  listTasks(runId: string): Task[];
  getTask(id: string): Task | undefined;
  upsertTask(task: Task): void;
  appendEvent(event: AgentEvent): unknown;
  appendLog(log: RunLogEvent): void;
  upsertApproval(approval: Approval): void;
  getApproval(id: string): Approval | undefined;
  listApprovals(runId: string): Approval[];
  getRunState<T>(runId: string): T | undefined;
  setRunState(runId: string, state: unknown): void;
}

export interface UnitTestRequest {
  project: Project;
  /** Absolute path of the checkout to test (a task worktree or the repo itself). */
  checkout: string;
  /** Repo path relative to the project folder ("." in a monorepo). */
  repo: string;
  area: TaskArea;
  signal: AbortSignal;
  log: (message: string) => void;
}

export interface E2ETestRequest {
  project: Project;
  signal: AbortSignal;
  log: (message: string) => void;
}

/**
 * Runs the project's chosen test frameworks. The orchestrator (not an
 * agent) runs tests; packages/testing provides the implementation.
 */
export interface TestingService {
  runUnit(request: UnitTestRequest): Promise<TestReport[]>;
  runE2E(request: E2ETestRequest): Promise<TestReport[]>;
  /** Where each layer's tests live, for the Test author's prompt. */
  layout(project: Project, area: TaskArea): { unit: string; unitDir: string; e2e: string; e2eDir: string };
}

export const NO_TESTING: TestingService = {
  runUnit: async () => [],
  runE2E: async () => [],
  layout: () => ({ unit: "the project's unit test framework", unitDir: "the existing test folder", e2e: "none", e2eDir: "e2e/" }),
};

export type Emit = (message: ServerMessage) => void;

export interface StartRunInput {
  mode: Run["mode"];
  brief: string;
  /** Single / Claude-native modes in a two-repo project: which repo to work in. */
  repo?: string;
  storyId?: string;
  /** Story acceptance criteria (given to coders and checked by the reviewer). */
  acceptance?: string;
  /** Execution modes: the approved plan to build (skips the Architect). */
  plan?: StoryPlan;
  /** Plan mode: revise this plan... */
  previousPlan?: StoryPlan;
  /** ...using this feedback from the human. */
  feedback?: string;
}

/**
 * Supplies project knowledge to agents: skills, project memory and history,
 * earlier logs and reference images. Implemented by the server on top of its
 * storage; the orchestrator just calls it before every agent turn.
 */
export interface ContextProvider {
  /** Extra system-prompt text for this role (skills, where to find project history). */
  systemAddendum(project: Project, role: RoleId, run: Run): Promise<string>;
  /** Write `.appforge/context/` into the agent's folder; returns reference image paths there. */
  prepare(project: Project, run: Run, cwd: string): Promise<{ images: string[] }>;
}

export interface RunHooks {
  /** Plan mode finished: the parsed plan for review. */
  onPlanReady?(run: Run, plan: StoryPlan, warnings: string[]): Promise<void> | void;
  /** Any run reached succeeded/failed/cancelled. */
  onRunFinished?(run: Run): Promise<void> | void;
}

/** Persisted per-run checkpoint, used to resume after a restart. */
export interface RunState {
  baseBranches: Record<string, string>;
  phase: "planning" | "building" | "integrating" | "done";
  planSummary?: string;
  e2eFixRounds?: number;
  /** Repo chosen for single / Claude-native runs. */
  repo?: string;
  acceptance?: string;
  plan?: StoryPlan;
  previousPlan?: StoryPlan;
  feedback?: string;
  /** Where the approved story spec was committed (relative to each repo). */
  specPath?: string;
}
