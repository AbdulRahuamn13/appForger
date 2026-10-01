import { existsSync } from "node:fs";
import { cp, readFile } from "node:fs/promises";
import path from "node:path";
import type {
  AccessPolicy,
  AgentEvent,
  AgentEventPayload,
  AgentSession,
  Approval,
  Project,
  ReviewResult,
  RoleId,
  Run,
  RunStatus,
  Task,
  TaskStatus,
  TestReport,
  TurnResult,
} from "@appforge/core";
import { newId, nowIso, parseReview, TERMINAL_RUN_STATUSES, truncate } from "@appforge/core";
import { runTurn, type ProviderRegistry } from "@appforge/providers";
import {
  architectPrompt,
  coderPrompt,
  conflictPrompt,
  getStack,
  integrationReportPrompt,
  nativeTeamPrompt,
  reviewerPrompt,
  roleAccess,
  singlePrompt,
  systemPrompt,
  testAuthorPrompt,
  TOOLING_SIDE_EFFECTS,
  type CoderFeedback,
  type PromptContext,
} from "@appforge/templates";
import { APPFORGE_DIR, checkCommand, enforceWritePolicy, GitRepo, type PolicyViolation, type ProcessRegistry } from "@appforge/workspace";
import { parsePlan, topoOrder } from "./plan.ts";
import { Deferred, Mutex, Semaphore } from "./sync.ts";
import { NO_TESTING, type Emit, type OrchestratorStore, type RunState, type StartRunInput, type TestingService } from "./types.ts";

export class RunCancelled extends Error {
  constructor(message = "Run cancelled") {
    super(message);
    this.name = "RunCancelled";
  }
}

export class BudgetExceeded extends Error {}

type SingleCommand = { kind: "message"; text: string } | { kind: "finish" } | { kind: "discard" };

interface ActiveRun {
  run: Run;
  project: Project;
  abort: AbortController;
  sessions: Set<AgentSession>;
  agentSeq: Map<RoleId, number>;
  spentUsd: number;
  semaphore: Semaphore;
  resume?: Deferred<void>;
  inbox?: Deferred<SingleCommand>;
  waitingApprovals: number;
  coderSessions: Map<string, AgentSession>;
  state: RunState;
}

interface AgentCall {
  role: RoleId;
  cwd: string;
  prompt: string;
  task?: Task;
  /** Checkout to check the agent's writes against its access policy afterwards. */
  policyRepo?: string;
  ownership?: string[];
  /** Override the role's default access (e.g. docs-only for the Integrator's report). */
  access?: AccessPolicy;
  session?: AgentSession;
  providerOverride?: string;
  env?: Record<string, string>;
}

interface AgentOutcome {
  result: TurnResult;
  violations: PolicyViolation[];
  session: AgentSession;
}

const ACTIVE_STATUSES: RunStatus[] = ["pending", "running", "paused", "awaiting-approval", "awaiting-input"];
const DONE_TASK: TaskStatus[] = ["merged", "cancelled"];

export interface OrchestratorDeps {
  store: OrchestratorStore;
  providers: ProviderRegistry;
  emit: Emit;
  testing?: TestingService;
  processes?: ProcessRegistry;
}

/**
 * Runs briefs through agent roles. It never talks to a model directly: every
 * step asks a ProviderAdapter to run a role in a folder, and every merge goes
 * through review, tests and (optionally) a human approval gate.
 */
export class Orchestrator {
  private readonly active = new Map<string, ActiveRun>();
  private readonly approvalWaiters = new Map<string, Deferred<{ approved: boolean; comment?: string }>>();
  private readonly mergeLocks = new Map<string, Mutex>();
  private readonly finished = new Map<string, Promise<void>>();
  private readonly testing: TestingService;

  constructor(private readonly deps: OrchestratorDeps) {
    this.testing = deps.testing ?? NO_TESTING;
  }

  // ───────────────────────── public API ─────────────────────────

  /** After a restart nothing is running: mark interrupted runs so the user can resume them. */
  recover(): number {
    const stale = this.deps.store.listRunsByStatus(ACTIVE_STATUSES);
    for (const run of stale) {
      run.status = "interrupted";
      run.updatedAt = nowIso();
      this.deps.store.updateRun(run);
    }
    return stale.length;
  }

  startRun(projectId: string, input: StartRunInput): Run {
    const project = this.deps.store.getProject(projectId);
    if (!project) throw new Error("Project not found");
    if (!input.brief?.trim()) throw new Error("A brief is required");
    this.assertProviders(project, input.mode);
    const now = nowIso();
    const run: Run = { id: newId("run"), projectId, mode: input.mode, brief: input.brief.trim(), status: "pending", createdAt: now, updatedAt: now };
    this.deps.store.insertRun(run);
    const repo = input.repo && project.repos.some((r) => r.path === input.repo) ? input.repo : project.repos[0]?.path ?? ".";
    this.deps.store.setRunState(run.id, { baseBranches: {}, phase: "planning", repo } satisfies RunState);
    this.deps.emit({ kind: "run-updated", run });
    this.launch(run, project);
    return run;
  }

  /** Continue an interrupted or failed run from its saved tasks. */
  resumeRun(runId: string): Run {
    const live = this.active.get(runId);
    if (live?.resume) {
      live.resume.resolve();
      return live.run;
    }
    if (live) throw new Error("Run is already active");
    const run = this.deps.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    if (run.status === "succeeded" || run.status === "cancelled") throw new Error(`Run already ${run.status}`);
    const project = this.deps.store.getProject(run.projectId);
    if (!project) throw new Error("Project not found");
    for (const task of this.deps.store.listTasks(run.id)) {
      if (task.status === "failed") this.saveTask({ ...task, status: "todo", attempts: 0 });
    }
    delete run.error;
    this.launch(run, project);
    return run;
  }

  stopRun(runId: string): boolean {
    const ar = this.active.get(runId);
    if (!ar) return false;
    ar.abort.abort();
    for (const s of ar.sessions) void s.stop();
    return true;
  }

  /** Global kill switch: stop every run, agent and child process. */
  killAll(): { runs: number; processes: number } {
    let runs = 0;
    for (const id of [...this.active.keys()]) if (this.stopRun(id)) runs++;
    const processes = this.deps.processes?.killAll() ?? 0;
    return { runs, processes };
  }

  decideApproval(approvalId: string, approved: boolean, comment?: string): Approval {
    const approval = this.deps.store.getApproval(approvalId);
    if (!approval) throw new Error("Approval not found");
    if (approval.status !== "pending") throw new Error(`Approval already ${approval.status}`);
    approval.status = approved ? "approved" : "rejected";
    approval.decidedAt = nowIso();
    if (comment?.trim()) approval.comment = comment.trim();
    this.deps.store.upsertApproval(approval);
    this.deps.emit({ kind: "approval-updated", approval });
    const waiter = this.approvalWaiters.get(approvalId);
    this.approvalWaiters.delete(approvalId);
    waiter?.resolve({ approved, ...(approval.comment ? { comment: approval.comment } : {}) });
    return approval;
  }

  /** Single mode: steer the agent. */
  sendCommand(runId: string, command: SingleCommand): void {
    const ar = this.active.get(runId);
    if (!ar || ar.run.mode !== "single") throw new Error("Run is not an active single-agent run");
    if (!ar.inbox) throw new Error("The agent is still working; wait for it to finish its turn");
    const inbox = ar.inbox;
    ar.inbox = undefined;
    inbox.resolve(command);
  }

  hasActiveRuns(projectId: string): boolean {
    return [...this.active.values()].some((ar) => ar.project.id === projectId);
  }

  isActive(runId: string): boolean {
    return this.active.has(runId);
  }

  /** Resolves when the run's current execution ends (for tests and shutdown). */
  async waitFor(runId: string): Promise<void> {
    await this.finished.get(runId);
  }

  // ───────────────────────── run lifecycle ─────────────────────────

  private assertProviders(project: Project, mode: Run["mode"]): void {
    if (mode === "swarm-native") {
      if (!this.deps.providers.has("claude-code")) throw new Error("Claude-native swarm needs the claude-code provider");
      return;
    }
    const roles: RoleId[] = mode === "single" ? ["coder", "reviewer"] : ["architect", "coder", "reviewer", "test-author", "integrator"];
    for (const role of roles) {
      const id = project.settings.roles[role]?.provider;
      if (!id || !this.deps.providers.has(id)) throw new Error(`No provider "${id}" for the ${role} role; check the project settings`);
    }
  }

  private launch(run: Run, project: Project): void {
    const state = this.deps.store.getRunState<RunState>(run.id) ?? { baseBranches: {}, phase: "planning" };
    const ar: ActiveRun = {
      run,
      project,
      abort: new AbortController(),
      sessions: new Set(),
      agentSeq: new Map(),
      spentUsd: 0,
      semaphore: new Semaphore(run.mode === "swarm" ? project.settings.concurrency : 1),
      waitingApprovals: 0,
      coderSessions: new Map(),
      state,
    };
    this.active.set(run.id, ar);
    const done = this.execute(ar).finally(() => {
      for (const s of ar.sessions) void s.stop();
      this.active.delete(run.id);
    });
    this.finished.set(run.id, done);
  }

  private async execute(ar: ActiveRun): Promise<void> {
    this.setRunStatus(ar, "running");
    try {
      await this.prepareRepos(ar);
      switch (ar.run.mode) {
        case "single":
          await this.runSingle(ar);
          break;
        case "pipeline":
          await this.runPlanned(ar, false);
          break;
        case "swarm":
          await this.runPlanned(ar, true);
          break;
        case "swarm-native":
          await this.runNative(ar);
          break;
      }
      if (!TERMINAL_RUN_STATUSES.includes(ar.run.status)) this.setRunStatus(ar, "succeeded");
    } catch (err) {
      if (err instanceof RunCancelled || ar.abort.signal.aborted) {
        this.log(ar, "warn", "Run stopped");
        for (const task of this.deps.store.listTasks(ar.run.id)) {
          if (!DONE_TASK.includes(task.status) && task.status !== "failed") this.saveTask({ ...task, status: "cancelled" });
        }
        this.setRunStatus(ar, "cancelled");
      } else {
        const message = (err as Error).message;
        this.log(ar, "error", message);
        this.setRunStatus(ar, "failed", message);
      }
    }
  }

  private async prepareRepos(ar: ActiveRun): Promise<void> {
    for (const ref of ar.project.repos) {
      const dir = this.repoDir(ar, ref.path);
      const repo = await GitRepo.init(dir);
      if (!ar.state.baseBranches[ref.path]) ar.state.baseBranches[ref.path] = await repo.currentBranch();
    }
    this.saveState(ar);
  }

  // ───────────────────────── modes ─────────────────────────

  private async runPlanned(ar: ActiveRun, parallel: boolean): Promise<void> {
    let tasks = this.deps.store.listTasks(ar.run.id);
    if (tasks.length === 0) tasks = await this.plan(ar, parallel);
    ar.state.phase = "building";
    this.saveState(ar);

    if (parallel) await this.runSwarm(ar, tasks);
    else {
      for (const task of topoOrder(tasks)) {
        this.checkAbort(ar);
        const current = this.task(task.id);
        if (DONE_TASK.includes(current.status)) continue;
        const blocked = this.blockedBy(ar, current);
        if (blocked) {
          this.log(ar, "warn", `Skipping ${current.key}: depends on ${blocked}, which did not merge`, current.id);
          this.saveTask({ ...current, status: "cancelled" });
          continue;
        }
        await this.processTask(ar, current);
      }
    }
    await this.integrate(ar);
  }

  private async plan(ar: ActiveRun, parallel: boolean): Promise<Task[]> {
    ar.state.phase = "planning";
    this.saveState(ar);
    const { project } = ar;
    const maxTasks = parallel ? 8 : 6;
    this.log(ar, "info", "Architect is writing the spec, API contract and task list");
    const { result } = await this.runAgent(ar, {
      role: "architect",
      cwd: project.path,
      prompt: architectPrompt(ar.run.brief, { maxTasks, parallel }),
      ...(project.shape === "monorepo" ? { policyRepo: project.path } : {}),
    });
    if (project.shape === "separate") {
      // Architect works from the parent folder; keep its writes out of both repos.
      for (const ref of project.repos) await enforceWritePolicy(new GitRepo(this.repoDir(ar, ref.path)), { mode: "read-only", shell: false });
    }
    if (result.status !== "completed") throw new Error(`Architect failed: ${result.error ?? result.status}`);
    const plan = parsePlan(result.text, ar.run.brief, project.shape, maxTasks);
    for (const w of plan.warnings) this.log(ar, "warn", w);
    if (plan.summary) ar.state.planSummary = plan.summary;
    await this.commitDocs(ar, "docs: spec, API contract and task plan (Architect)");

    const now = nowIso();
    const tasks = plan.tasks.map<Task>((t, i) => ({
      id: newId("task"),
      runId: ar.run.id,
      key: t.key,
      title: t.title,
      description: t.description,
      area: t.area,
      repo: t.repo,
      status: "todo",
      dependsOn: t.dependsOn,
      files: t.files,
      attempts: 0,
      order: i,
      createdAt: now,
      updatedAt: now,
    }));
    for (const task of tasks) this.saveTask(task);
    this.log(ar, "info", `Plan: ${tasks.length} task(s) — ${tasks.map((t) => t.key).join(", ")}`);
    return tasks;
  }

  /** Commit the docs/ folder on the base branch (copying it into each repo for two-repo projects). */
  private async commitDocs(ar: ActiveRun, message: string): Promise<void> {
    const { project } = ar;
    if (project.shape === "monorepo") {
      await new GitRepo(project.path).commitAll(message, ["docs", "README.md"]);
      return;
    }
    const docs = path.join(project.path, "docs");
    if (!existsSync(docs)) return;
    for (const ref of project.repos) {
      const dir = this.repoDir(ar, ref.path);
      await cp(docs, path.join(dir, "docs"), { recursive: true });
      await new GitRepo(dir).commitAll(message, ["docs"]);
    }
  }

  private async runSwarm(ar: ActiveRun, tasks: Task[]): Promise<void> {
    const pending = new Map(tasks.filter((t) => !DONE_TASK.includes(this.task(t.id).status)).map((t) => [t.key, t]));
    const running = new Map<string, Promise<string>>();
    this.log(ar, "info", `Swarm: up to ${ar.project.settings.concurrency} agents at once`);
    while (pending.size || running.size) {
      this.checkAbort(ar);
      for (const [key, task] of [...pending]) {
        const blocked = this.blockedBy(ar, task);
        if (blocked) {
          pending.delete(key);
          this.log(ar, "warn", `Skipping ${key}: depends on ${blocked}, which did not merge`, task.id);
          this.saveTask({ ...this.task(task.id), status: "cancelled" });
          continue;
        }
        const ready = task.dependsOn.every((d) => this.taskByKey(ar, d)?.status === "merged");
        if (!ready) continue;
        pending.delete(key);
        running.set(
          key,
          this.processTask(ar, this.task(task.id)).then(
            () => key,
            (err: unknown) => {
              if (err instanceof RunCancelled || err instanceof BudgetExceeded) throw err;
              this.log(ar, "error", `${key}: ${(err as Error).message}`, task.id);
              this.saveTask({ ...this.task(task.id), status: "failed" });
              return key;
            },
          ),
        );
      }
      if (running.size === 0) {
        for (const [key, task] of pending) {
          this.log(ar, "error", `${key} can never start (unmet dependencies)`, task.id);
          this.saveTask({ ...this.task(task.id), status: "failed" });
        }
        break;
      }
      const finishedKey = await Promise.race(running.values());
      running.delete(finishedKey);
    }
  }

  private async runSingle(ar: ActiveRun): Promise<void> {
    const repo = ar.state.repo ?? ar.project.repos[0]?.path ?? ".";
    let task = this.deps.store.listTasks(ar.run.id)[0];
    if (!task) {
      const now = nowIso();
      task = {
        id: newId("task"),
        runId: ar.run.id,
        key: "single",
        title: truncate(ar.run.brief.split("\n")[0] ?? "Single agent", 80),
        description: ar.run.brief,
        area: ar.project.repos.find((r) => r.path === repo)?.area ?? "shared",
        repo,
        status: "todo",
        dependsOn: [],
        files: [],
        attempts: 0,
        order: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.saveTask(task);
    }
    if (DONE_TASK.includes(task.status)) return;
    const wt = await this.ensureWorktree(ar, task);
    task = this.task(task.id);
    let prompt = task.status === "todo" ? singlePrompt(ar.run.brief) : undefined;
    for (;;) {
      if (prompt) {
        this.saveTask({ ...this.task(task.id), status: "in-progress" });
        const session = ar.coderSessions.get(task.id);
        const outcome = await this.runAgent(ar, { role: "coder", cwd: wt, prompt, task: this.task(task.id), policyRepo: wt, ...(session ? { session } : {}) });
        ar.coderSessions.set(task.id, outcome.session);
        await new GitRepo(wt).commitAll(`wip: ${task.title} (single agent)`);
      }
      this.saveTask({ ...this.task(task.id), status: "todo" });
      this.setRunStatus(ar, "awaiting-input");
      this.log(ar, "info", "Waiting for you: send another instruction, finish (review + merge), or discard", task.id);
      const command = await this.waitForCommand(ar);
      this.setRunStatus(ar, "running");
      if (command.kind === "message") {
        prompt = command.text;
        continue;
      }
      if (command.kind === "discard") {
        await this.discardTask(ar, this.task(task.id));
        throw new RunCancelled("Discarded");
      }
      break;
    }
    // Finish: review + tests are shown to you, then the approval gate decides.
    await this.processTask(ar, this.task(task.id), { skipCoder: true, alwaysApprove: true });
  }

  private async runNative(ar: ActiveRun): Promise<void> {
    const repo = ar.state.repo ?? ar.project.repos[0]?.path ?? ".";
    let task = this.deps.store.listTasks(ar.run.id)[0];
    if (!task) {
      const now = nowIso();
      task = {
        id: newId("task"),
        runId: ar.run.id,
        key: "agent-team",
        title: "Claude agent team",
        description: ar.run.brief,
        area: ar.project.repos.find((r) => r.path === repo)?.area ?? "shared",
        repo,
        status: "todo",
        dependsOn: [],
        files: [],
        attempts: 0,
        order: 0,
        createdAt: now,
        updatedAt: now,
      };
      this.saveTask(task);
    }
    this.log(ar, "info", "Handing the brief to a Claude Code lead session with Agent Teams enabled");
    await this.processTask(ar, this.task(task.id), { native: true });
    await this.integrate(ar);
  }

  // ───────────────────────── one task: code → review → test → approve → merge ─────────────────────────

  private async processTask(
    ar: ActiveRun,
    initial: Task,
    options: { skipCoder?: boolean; alwaysApprove?: boolean; native?: boolean } = {},
  ): Promise<void> {
    if (DONE_TASK.includes(initial.status)) return;
    const { project } = ar;
    const settings = project.settings;
    const repoDir = this.repoDir(ar, initial.repo);
    const repo = new GitRepo(repoDir);
    const base = ar.state.baseBranches[initial.repo] ?? "main";
    const wt = await this.ensureWorktree(ar, initial);
    const wtRepo = new GitRepo(wt);
    let task = this.task(initial.id);
    const branch = task.branch as string;

    let feedback: CoderFeedback | undefined = task.review?.verdict === "request-changes" ? { review: task.review } : undefined;
    let skipBuild = task.status === "awaiting-approval" || task.status === "ready-to-merge";
    let skipCoder = options.skipCoder ?? false;
    let testsWritten = false;
    let reverted: string[] = [];
    const fail = (reason: string) => {
      this.log(ar, "error", `${task.key}: ${reason}`, task.id);
      this.saveTask({ ...this.task(task.id), status: "failed" });
    };

    for (;;) {
      this.checkAbort(ar);
      task = this.task(task.id);
      if (!skipBuild) {
        // 1. Coder
        if (!skipCoder) {
          this.saveTask({ ...task, status: "in-progress" });
          const prompt = options.native && !feedback ? nativeTeamPrompt(ar.run.brief, settings.concurrency) : coderPrompt(task, feedback);
          const session = ar.coderSessions.get(task.id);
          const outcome = await this.runAgent(ar, {
            role: "coder",
            cwd: wt,
            prompt,
            task,
            policyRepo: wt,
            // Ownership is guidance in pipeline mode and enforced when coders run in parallel.
            ownership: ar.run.mode === "swarm" ? task.files : [],
            ...(session ? { session } : {}),
            ...(options.native ? { providerOverride: "claude-code", env: { CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS: "1" } } : {}),
          });
          ar.coderSessions.set(task.id, outcome.session);
          if (outcome.result.status !== "completed") {
            if (task.attempts >= settings.maxFixLoops) return fail(`coder failed: ${outcome.result.error ?? outcome.result.status}`);
            this.saveTask({ ...this.task(task.id), attempts: task.attempts + 1 });
            feedback = { humanComment: `Your previous attempt ended with an error: ${outcome.result.error ?? outcome.result.status}. Try again.` };
            continue;
          }
          await wtRepo.commitAll(`feat(${task.key}): ${task.title} (${options.native ? "agent team" : "coder"})`);
          // Out-of-scope writes were already reverted; mention them if the coder goes round again.
          reverted = outcome.violations.map((v) => `${v.path}: ${v.reason}`);
        }
        skipCoder = false;

        // 2. Reviewer (read-only)
        this.saveTask({ ...this.task(task.id), status: "review" });
        const diff = await repo.diffText(base, branch);
        let review: ReviewResult;
        if (!diff.trim()) {
          review = { verdict: "request-changes", issues: [{ severity: "blocker", message: "No changes were made for this task." }] };
        } else {
          const reviewer = await this.runAgent(ar, { role: "reviewer", cwd: wt, prompt: reviewerPrompt(task, diff), task: this.task(task.id), policyRepo: wt });
          if (reviewer.result.status !== "completed") return fail(`reviewer failed: ${reviewer.result.error ?? reviewer.result.status}`);
          review = parseReview(reviewer.result.text);
        }
        task = this.saveTask({ ...this.task(task.id), review });
        this.log(ar, review.verdict === "approve" ? "info" : "warn", `${task.key}: review ${review.verdict}${review.summary ? ` — ${truncate(review.summary, 200)}` : ""}`, task.id);
        if (review.verdict !== "approve" && !options.alwaysApprove) {
          if (task.attempts >= settings.maxFixLoops) return fail(`still not approved after ${task.attempts} fix loop(s)`);
          this.saveTask({ ...task, status: "changes-requested", attempts: task.attempts + 1 });
          feedback = { review, ...(reverted.length ? { policyViolations: reverted } : {}) };
          continue;
        }

        // 3. Tests: Test author writes them once, the orchestrator runs them.
        this.saveTask({ ...this.task(task.id), status: "testing" });
        const layout = this.testing.layout(project, task.area);
        const hasTests = this.hasTestFrameworks(project, task.area);
        if (hasTests && !testsWritten && !options.alwaysApprove) {
          const author = await this.runAgent(ar, { role: "test-author", cwd: wt, prompt: testAuthorPrompt(task, layout), task: this.task(task.id), policyRepo: wt });
          if (author.result.status === "completed") await wtRepo.commitAll(`test(${task.key}): ${task.title} (test author)`);
          else this.log(ar, "warn", `${task.key}: test author failed: ${author.result.error ?? author.result.status}`, task.id);
          testsWritten = true;
        }
        const reports = hasTests
          ? await this.testing.runUnit({ project, checkout: wt, repo: task.repo, area: task.area, signal: ar.abort.signal, log: (m) => this.log(ar, "info", m, task.id) })
          : [];
        this.publishReports(ar, task.id, reports);
        task = this.saveTask({ ...this.task(task.id), testReports: reports });
        const failing = reports.filter((r) => r.failed > 0 || r.error);
        if (failing.length && !options.alwaysApprove) {
          if (task.attempts >= settings.maxFixLoops) return fail(`tests still failing after ${task.attempts} fix loop(s)`);
          this.saveTask({ ...task, status: "changes-requested", attempts: task.attempts + 1 });
          feedback = { testReports: failing, ...(reverted.length ? { policyViolations: reverted } : {}) };
          continue;
        }
      }
      skipBuild = false;

      // 4. Approval gate
      if (settings.requireApproval || options.alwaysApprove) {
        const current = this.task(task.id);
        // Keep the original timestamp when resuming at the gate, so a decision made meanwhile is recognised.
        const atGate = current.status === "awaiting-approval" ? current : this.saveTask({ ...current, status: "awaiting-approval" });
        const decision = await this.requestApproval(ar, atGate, base);
        if (!decision.approved) {
          task = this.task(task.id);
          if (decision.comment && task.attempts < settings.maxFixLoops && !options.alwaysApprove) {
            this.saveTask({ ...task, status: "changes-requested", attempts: task.attempts + 1 });
            feedback = { humanComment: decision.comment };
            continue;
          }
          if (decision.comment && options.alwaysApprove) {
            // Single mode: hand the comment back to the agent and go round again.
            this.saveTask({ ...task, status: "changes-requested" });
            feedback = { humanComment: decision.comment };
            continue;
          }
          this.log(ar, "warn", `${task.key}: rejected; branch ${branch} is kept for reference`, task.id);
          this.saveTask({ ...task, status: "cancelled" });
          return;
        }
      }

      // 5. Merge
      this.saveTask({ ...this.task(task.id), status: "ready-to-merge" });
      try {
        await this.merge(ar, this.task(task.id), repoDir, base);
      } catch (err) {
        if (err instanceof RunCancelled) throw err;
        return fail((err as Error).message);
      }
      this.saveTask({ ...this.task(task.id), status: "merged" });
      await repo.removeWorktree(wt);
      ar.coderSessions.delete(task.id);
      this.log(ar, "info", `${task.key}: merged ${branch} into ${base}`, task.id);
      return;
    }
  }

  private hasTestFrameworks(project: Project, area: Task["area"]): boolean {
    const s = project.settings;
    if (area === "backend") return s.unitBackend !== "none";
    if (area === "frontend") return s.unitFrontend !== "none";
    return s.unitBackend !== "none" || s.unitFrontend !== "none";
  }

  private async ensureWorktree(ar: ActiveRun, task: Task): Promise<string> {
    const repoDir = this.repoDir(ar, task.repo);
    const repo = new GitRepo(repoDir);
    const short = ar.run.id.slice(-6);
    const branch = task.branch ?? `appforge/${short}/${task.key}`;
    const wt = task.worktreePath ?? path.join(repoDir, APPFORGE_DIR, "worktrees", `${short}-${task.key}`);
    if (!existsSync(wt)) {
      const base = ar.state.baseBranches[task.repo] ?? "main";
      await repo.createWorktree(wt, branch, base);
      this.log(ar, "info", `${task.key}: worktree ${path.relative(ar.project.path, wt)} on branch ${branch}`, task.id);
    }
    if (task.branch !== branch || task.worktreePath !== wt) this.saveTask({ ...task, branch, worktreePath: wt });
    return wt;
  }

  private async discardTask(ar: ActiveRun, task: Task): Promise<void> {
    const repo = new GitRepo(this.repoDir(ar, task.repo));
    if (task.worktreePath) await repo.removeWorktree(task.worktreePath);
    if (task.branch) await repo.deleteBranch(task.branch);
    this.saveTask({ ...task, status: "cancelled" });
  }

  private async merge(ar: ActiveRun, task: Task, repoDir: string, base: string): Promise<void> {
    const lock = this.mergeLocks.get(repoDir) ?? new Mutex();
    this.mergeLocks.set(repoDir, lock);
    const branch = task.branch as string;
    await lock.with(async () => {
      const repo = new GitRepo(repoDir);
      // The main checkout must be on the base branch and clean before AppForge merges into it.
      for (;;) {
        this.checkAbort(ar);
        const current = await repo.currentBranch();
        const dirty = await repo.changedFiles();
        if (current === base && dirty.length === 0) break;
        await this.pause(
          ar,
          current !== base
            ? `${path.relative(ar.project.path, repoDir) || "Project folder"} is on branch ${current}; switch back to ${base} and press Resume to merge ${task.key}.`
            : `Uncommitted changes in ${path.relative(ar.project.path, repoDir) || "the project folder"} (${dirty.slice(0, 5).map((d) => d.path).join(", ")}); commit or stash them and press Resume to merge ${task.key}.`,
        );
      }
      const result = await repo.merge(branch, `Merge ${branch}: ${task.title} (AppForge)`);
      if (result.ok) return;
      this.log(ar, "warn", `${task.key}: merge conflicts in ${result.conflicts.join(", ")}; asking the Integrator`, task.id);
      await this.runAgent(ar, { role: "integrator", cwd: repoDir, prompt: conflictPrompt(branch, result.conflicts, task.title), task });
      const unresolved: string[] = [];
      for (const file of result.conflicts) {
        const text = await readFile(path.join(repoDir, file), "utf8").catch(() => "");
        if (/^(<<<<<<<|>>>>>>>) /m.test(text)) unresolved.push(file);
      }
      if (unresolved.length) {
        await repo.abortMerge();
        throw new Error(`Integrator could not resolve conflicts in ${unresolved.join(", ")}; branch ${branch} left unmerged`);
      }
      await repo.concludeMerge(`Merge ${branch}: ${task.title} (AppForge; conflicts resolved by the Integrator)`);
    });
  }

  // ───────────────────────── integration ─────────────────────────

  private async integrate(ar: ActiveRun): Promise<void> {
    const { project } = ar;
    ar.state.phase = "integrating";
    this.saveState(ar);
    let tasks = this.deps.store.listTasks(ar.run.id);
    if (!tasks.some((t) => t.status === "merged")) {
      const failed = tasks.filter((t) => t.status !== "merged").map((t) => t.key);
      if (failed.length) throw new Error(`Nothing merged (${failed.join(", ")} did not complete)`);
      return;
    }

    // Full suites on the merged code, then E2E with the app running.
    let reports = await this.runAllTests(ar);
    let rounds = ar.state.e2eFixRounds ?? 0;
    while (reports.some((r) => r.failed > 0 || r.error) && rounds < project.settings.maxFixLoops) {
      rounds++;
      ar.state.e2eFixRounds = rounds;
      this.saveState(ar);
      const failing = reports.filter((r) => r.failed > 0 || r.error);
      this.log(ar, "warn", `Integration tests failing (${failing.map((r) => r.framework).join(", ")}); fix round ${rounds}`);
      const now = nowIso();
      const area = failing.some((r) => r.layer === "e2e") ? "frontend" : "shared";
      const repo = project.shape === "monorepo" ? "." : (project.repos.find((r) => r.area === area)?.path ?? project.repos[0]?.path ?? ".");
      const fix: Task = {
        id: newId("task"),
        runId: ar.run.id,
        key: `integration-fix-${rounds}`,
        title: `Fix failing integration tests (round ${rounds})`,
        description: `The merged code fails these tests. Fix the application code (not the tests, unless a test is clearly wrong).\n\n${failing
          .flatMap((r) => r.cases.filter((c) => c.status === "failed").slice(0, 15).map((c) => `- [${r.framework}] ${c.name}: ${truncate(c.error?.message ?? "failed", 500)}`))
          .join("\n")}${failing.filter((r) => r.error).map((r) => `\n- [${r.framework}] runner error: ${r.error}`).join("")}`,
        area,
        repo,
        status: "todo",
        dependsOn: [],
        files: [],
        attempts: 0,
        order: tasks.length,
        createdAt: now,
        updatedAt: now,
      };
      this.saveTask(fix);
      await this.processTask(ar, fix);
      reports = await this.runAllTests(ar);
    }

    tasks = this.deps.store.listTasks(ar.run.id);
    const summary = [
      ar.state.planSummary ? `Plan: ${ar.state.planSummary}` : "",
      ...tasks.map((t) => `- ${t.key} (${t.title}): ${t.status}${t.review?.summary ? ` — review: ${truncate(t.review.summary, 200)}` : ""}`),
      ...reports.map((r) => `- ${r.framework} ${r.layer} in ${r.cwd}: ${r.passed}/${r.total} passed${r.error ? ` (error: ${truncate(r.error, 200)})` : ""}`),
    ]
      .filter(Boolean)
      .join("\n");
    const reportRepo = project.shape === "monorepo" ? project.path : this.repoDir(ar, project.repos[0]?.path ?? ".");
    const docsOnly = roleAccess("architect");
    const integrator = await this.runAgent(ar, { role: "integrator", cwd: reportRepo, prompt: integrationReportPrompt(summary), policyRepo: reportRepo, access: docsOnly });
    if (integrator.result.status === "completed") await new GitRepo(reportRepo).commitAll("docs: integration report (Integrator)", ["docs"]);

    ar.state.phase = "done";
    this.saveState(ar);
    const notMerged = tasks.filter((t) => t.status !== "merged");
    const red = reports.filter((r) => r.failed > 0 || r.error);
    if (notMerged.length || red.length) {
      const parts = [];
      if (notMerged.length) parts.push(`${notMerged.length} task(s) not merged: ${notMerged.map((t) => `${t.key} (${t.status})`).join(", ")}`);
      if (red.length) parts.push(`tests failing: ${red.map((r) => r.framework).join(", ")}`);
      throw new Error(parts.join("; "));
    }
  }

  private async runAllTests(ar: ActiveRun): Promise<TestReport[]> {
    const { project } = ar;
    const reports: TestReport[] = [];
    const log = (m: string) => this.log(ar, "info", m);
    for (const ref of project.repos) {
      if (!this.hasTestFrameworks(project, ref.area)) continue;
      reports.push(...(await this.testing.runUnit({ project, checkout: this.repoDir(ar, ref.path), repo: ref.path, area: ref.area, signal: ar.abort.signal, log })));
    }
    if (project.settings.e2e !== "none") reports.push(...(await this.testing.runE2E({ project, signal: ar.abort.signal, log })));
    this.publishReports(ar, undefined, reports);
    return reports;
  }

  private publishReports(ar: ActiveRun, taskId: string | undefined, reports: TestReport[]): void {
    for (const report of reports) {
      this.deps.emit({ kind: "test-report", runId: ar.run.id, ...(taskId ? { taskId } : {}), report });
      this.log(
        ar,
        report.failed || report.error ? "warn" : "info",
        `${report.framework} (${report.layer}, ${report.cwd}): ${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped${report.error ? ` — ${truncate(report.error, 300)}` : ""}`,
        taskId,
      );
    }
  }

  // ───────────────────────── agents ─────────────────────────

  private promptContext(project: Project): PromptContext {
    return { projectName: project.name, shape: project.shape, stack: getStack(project.stackId), settings: project.settings };
  }

  private async runAgent(ar: ActiveRun, call: AgentCall): Promise<AgentOutcome> {
    const { project } = ar;
    for (;;) {
      this.checkAbort(ar);
      const assignment = project.settings.roles[call.role];
      const providerId = call.providerOverride ?? assignment.provider;
      const adapter = this.deps.providers.get(providerId);
      const model = call.providerOverride ? undefined : assignment.model;
      const access = call.access ?? roleAccess(call.role);
      const seq = (ar.agentSeq.get(call.role) ?? 0) + 1;
      ar.agentSeq.set(call.role, seq);
      const agentId = `${call.role}-${seq}`;

      const release = await ar.semaphore.acquire();
      let result: TurnResult;
      let session = call.session;
      try {
        this.checkAbort(ar);
        session ??= await adapter.startSession({
          cwd: call.cwd,
          role: call.role,
          systemPrompt: systemPrompt(call.role, this.promptContext(project)),
          access,
          checkCommand: (command) => {
            const verdict = checkCommand(command, call.cwd);
            return verdict.ok ? undefined : verdict.reason;
          },
          ...(model ? { model } : {}),
          ...(call.env ? { env: call.env } : {}),
        });
        ar.sessions.add(session);
        this.log(ar, "info", `${agentId} started on ${adapter.label}${model ? ` (${model})` : ""}${call.task ? ` for ${call.task.key}` : ""}`, call.task?.id);
        const live = session;
        result = await runTurn(live, call.prompt, (payload) => this.emitAgent(ar, { agentId, role: call.role, provider: providerId, ...(call.task ? { taskId: call.task.id } : {}) }, payload));
      } finally {
        release();
      }

      ar.spentUsd += result.costUsd;
      const violations = call.policyRepo
        ? await enforceWritePolicy(new GitRepo(call.policyRepo), access, call.ownership ?? [], [...TOOLING_SIDE_EFFECTS, `${APPFORGE_DIR}/**`])
        : [];
      for (const v of violations) this.log(ar, "warn", `${agentId}: reverted ${v.path} (${v.reason})`, call.task?.id);

      if (ar.abort.signal.aborted || result.status === "stopped") throw new RunCancelled();
      const budget = project.settings.budgetUsd;
      if (budget && ar.spentUsd > budget) throw new BudgetExceeded(`Budget of $${budget.toFixed(2)} exceeded ($${ar.spentUsd.toFixed(2)} spent)`);
      if (result.rateLimited) {
        await this.pause(ar, `${adapter.label} hit a rate or plan limit. Press Resume when it has reset to retry ${agentId}.`);
        call = { ...call, session };
        continue;
      }
      return { result, violations, session };
    }
  }

  private emitAgent(ar: ActiveRun, envelope: Pick<AgentEvent, "agentId" | "role" | "provider" | "taskId">, payload: AgentEventPayload): void {
    const event = { id: newId("ev"), runId: ar.run.id, ts: nowIso(), ...envelope, ...payload } as AgentEvent;
    this.deps.store.appendEvent(event);
    this.deps.emit({ kind: "agent-event", event });
  }

  // ───────────────────────── waiting on the human ─────────────────────────

  private async requestApproval(ar: ActiveRun, task: Task, base: string): Promise<{ approved: boolean; comment?: string }> {
    const existing = this.deps.store
      .listApprovals(ar.run.id)
      .filter((a) => a.taskId === task.id)
      .at(-1);
    // A decision made while AppForge was down still counts.
    if (existing && existing.status !== "pending" && task.status === "awaiting-approval" && existing.createdAt >= task.updatedAt) {
      return { approved: existing.status === "approved", ...(existing.comment ? { comment: existing.comment } : {}) };
    }
    const approval: Approval =
      existing?.status === "pending"
        ? existing
        : {
            id: newId("apr"),
            runId: ar.run.id,
            taskId: task.id,
            title: task.title,
            repo: task.repo,
            branch: task.branch as string,
            baseBranch: base,
            status: "pending",
            createdAt: nowIso(),
          };
    this.deps.store.upsertApproval(approval);
    this.deps.emit({ kind: "approval-updated", approval });
    this.log(ar, "info", `${task.key}: waiting for your approval to merge ${approval.branch} → ${base}`, task.id);
    const waiter = new Deferred<{ approved: boolean; comment?: string }>();
    this.approvalWaiters.set(approval.id, waiter);
    ar.waitingApprovals++;
    this.setRunStatus(ar, "awaiting-approval");
    try {
      return await this.raceAbort(ar, waiter.promise);
    } finally {
      this.approvalWaiters.delete(approval.id);
      ar.waitingApprovals--;
      if (ar.waitingApprovals === 0 && ar.run.status === "awaiting-approval") this.setRunStatus(ar, "running");
    }
  }

  private async waitForCommand(ar: ActiveRun): Promise<SingleCommand> {
    ar.inbox = new Deferred<SingleCommand>();
    try {
      return await this.raceAbort(ar, ar.inbox.promise);
    } finally {
      ar.inbox = undefined;
    }
  }

  private async pause(ar: ActiveRun, reason: string): Promise<void> {
    ar.resume = new Deferred<void>();
    const previous = ar.run.status;
    this.log(ar, "warn", `Paused: ${reason}`);
    this.setRunStatus(ar, "paused", reason);
    try {
      await this.raceAbort(ar, ar.resume.promise);
    } finally {
      ar.resume = undefined;
    }
    delete ar.run.error;
    this.setRunStatus(ar, previous === "paused" ? "running" : previous);
    this.log(ar, "info", "Resumed");
  }

  private raceAbort<T>(ar: ActiveRun, promise: Promise<T>): Promise<T> {
    const signal = ar.abort.signal;
    if (signal.aborted) return Promise.reject(new RunCancelled());
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new RunCancelled());
      signal.addEventListener("abort", onAbort, { once: true });
      promise.then(
        (v) => {
          signal.removeEventListener("abort", onAbort);
          resolve(v);
        },
        (e: unknown) => {
          signal.removeEventListener("abort", onAbort);
          reject(e);
        },
      );
    });
  }

  // ───────────────────────── helpers ─────────────────────────

  private checkAbort(ar: ActiveRun): void {
    if (ar.abort.signal.aborted) throw new RunCancelled();
  }

  private repoDir(ar: ActiveRun, repo: string): string {
    return path.join(ar.project.path, repo);
  }

  private task(id: string): Task {
    const t = this.deps.store.getTask(id);
    if (!t) throw new Error(`Task ${id} not found`);
    return t;
  }

  private taskByKey(ar: ActiveRun, key: string): Task | undefined {
    return this.deps.store.listTasks(ar.run.id).find((t) => t.key === key);
  }

  /** Key of a dependency that failed or was cancelled, if any. */
  private blockedBy(ar: ActiveRun, task: Task): string | undefined {
    return task.dependsOn.find((d) => {
      const dep = this.taskByKey(ar, d);
      return !dep || dep.status === "failed" || dep.status === "cancelled";
    });
  }

  private saveTask(task: Task): Task {
    const next = { ...task, updatedAt: nowIso() };
    this.deps.store.upsertTask(next);
    this.deps.emit({ kind: "task-updated", task: next });
    return next;
  }

  private saveState(ar: ActiveRun): void {
    this.deps.store.setRunState(ar.run.id, ar.state);
  }

  private setRunStatus(ar: ActiveRun, status: RunStatus, error?: string): void {
    ar.run = { ...ar.run, status, updatedAt: nowIso() };
    if (error) ar.run.error = error;
    else if (status !== "failed" && status !== "paused") delete ar.run.error;
    if (TERMINAL_RUN_STATUSES.includes(status)) ar.run.finishedAt = ar.run.updatedAt;
    this.deps.store.updateRun(ar.run);
    this.deps.emit({ kind: "run-updated", run: ar.run });
  }

  private log(ar: ActiveRun, level: "info" | "warn" | "error", message: string, taskId?: string): void {
    const log = { runId: ar.run.id, level, message, ts: nowIso(), ...(taskId ? { taskId } : {}) };
    this.deps.store.appendLog(log);
    this.deps.emit({ kind: "run-log", log });
  }
}
