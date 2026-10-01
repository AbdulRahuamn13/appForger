import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Approval, Run, ServerMessage, TestReport } from "@appforge/core";
import { ScriptedAdapter, type ScriptContext, type ScriptStep } from "@appforge/providers";
import { GitRepo } from "@appforge/workspace";
import { parsePlan, topoOrder, type TestingService } from "../src/index.ts";
import { APPROVE, harness, planJson, REQUEST_CHANGES, taskKey, type Harness } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  if (h) {
    h.orchestrator.killAll();
    await h.cleanup();
  }
  h = undefined;
});

/** Retry `fn` until it stops throwing. */
async function eventually(fn: () => void, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      fn();
      return;
    } catch (err) {
      if (Date.now() > deadline) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
}

const runStatus = (msg: ServerMessage, id: string, status: Run["status"]) => msg.kind === "run-updated" && msg.run.id === id && msg.run.status === status;

/** A script where every role behaves well; override per role. */
function script(overrides: Partial<Record<ScriptContext["role"], (ctx: ScriptContext) => ScriptStep | Promise<ScriptStep>>> = {}, plan = planJson([{ key: "api" }, { key: "ui", area: "frontend", dependsOn: ["api"] }])) {
  return (ctx: ScriptContext): ScriptStep | Promise<ScriptStep> => {
    const custom = overrides[ctx.role];
    if (custom) return custom(ctx);
    switch (ctx.role) {
      case "architect":
        return { text: plan, files: { "docs/SPEC.md": "# Spec\n", "docs/openapi.yaml": "openapi: 3.1.0\n" } };
      case "coder":
        return { text: "done", files: { [`src/${taskKey(ctx.prompt)}.ts`]: `export const x = "${taskKey(ctx.prompt)}-${ctx.turn}";\n` } };
      case "reviewer":
        return { text: APPROVE };
      case "test-author":
        return { text: "tests", files: { [`tests/${taskKey(ctx.prompt)}.test.ts`]: "// test\n" } };
      case "integrator":
        return { text: "report", files: { "docs/REPORT.md": "# Report\n" } };
    }
  };
}

describe("plan parsing", () => {
  it("normalises keys, dependencies, ownership and cycles", () => {
    const plan = parsePlan(
      planJson([
        { key: "API Server", files: ["backend/src/**"] },
        { key: "web", area: "frontend", dependsOn: ["api-server", "nope"], files: ["frontend/src/**", "backend/x/**"] },
        { key: "a", dependsOn: ["b"] },
        { key: "b", dependsOn: ["a"] },
      ]),
      "brief",
      "separate",
      10,
    );
    expect(plan.tasks.map((t) => [t.key, t.repo])).toEqual([
      ["api-server", "backend"],
      ["web", "frontend"],
      ["a", "backend"],
      ["b", "backend"],
    ]);
    expect(plan.tasks[0]?.files).toEqual(["src/**"]);
    expect(plan.tasks[1]?.files).toEqual(["src/**"]);
    expect(plan.tasks[1]?.dependsOn).toEqual(["api-server"]);
    expect(plan.warnings.join(" ")).toMatch(/cycle/);
    expect(plan.tasks[3]?.dependsOn).toEqual(["a"]);
    expect(plan.tasks[2]?.dependsOn).toEqual([]);
  });

  it("falls back to one task when the Architect returns no JSON", () => {
    const plan = parsePlan("I wrote the spec!", "Build a todo app", "monorepo", 5);
    expect(plan.tasks).toHaveLength(1);
    expect(plan.tasks[0]?.description).toBe("Build a todo app");
  });

  it("orders tasks topologically", () => {
    const order = topoOrder([
      { key: "c", dependsOn: ["b"], order: 0 },
      { key: "b", dependsOn: ["a"], order: 1 },
      { key: "a", dependsOn: [], order: 2 },
    ]);
    expect(order.map((t) => t.key)).toEqual(["a", "b", "c"]);
  });
});

describe("pipeline mode", () => {
  it("goes from brief to spec, reviewed branches, merges and a report", async () => {
    h = await harness(script());
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "todo API + React list" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");

    const tasks = h.store.listTasks(run.id);
    expect(tasks.map((t) => [t.key, t.status])).toEqual([
      ["api", "merged"],
      ["ui", "merged"],
    ]);
    // Code landed on main through merge commits; docs and report were committed.
    expect(await readFile(path.join(h.dir, "src/api.ts"), "utf8")).toContain("api-0");
    expect(existsSync(path.join(h.dir, "docs/SPEC.md"))).toBe(true);
    expect(existsSync(path.join(h.dir, "docs/REPORT.md"))).toBe(true);
    const repo = new GitRepo(h.dir);
    const log = (await repo.log(20)).map((c) => c.message);
    expect(log.some((m) => m.startsWith("Merge appforge/"))).toBe(true);
    expect(log).toContain("docs: integration report (Integrator)");
    expect(await repo.changedFiles()).toEqual([]);
    expect(await repo.currentBranch()).toBe("main");
    // Worktrees were cleaned up after merging.
    for (const t of tasks) expect(existsSync(t.worktreePath as string)).toBe(false);
    // Roles ran in order: architect, then coder → reviewer per task, then integrator.
    expect(h.adapter.log.map((c) => c.role)).toEqual(["architect", "coder", "reviewer", "coder", "reviewer", "integrator"]);
    // Agent events were persisted with their envelope.
    expect(h.store.events.some((e) => e.agentId === "coder-1" && e.type === "file-change")).toBe(true);
  });

  it("loops back to the coder with reviewer feedback", async () => {
    let reviews = 0;
    h = await harness(script({ reviewer: () => ({ text: reviews++ === 0 ? REQUEST_CHANGES : APPROVE }) }, planJson([{ key: "api" }])));
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status).toBe("succeeded");
    const coderPrompts = h.adapter.log.filter((c) => c.role === "coder").map((c) => c.prompt);
    expect(coderPrompts).toHaveLength(2);
    expect(coderPrompts[1]).toContain("[major] (x.ts) handle the empty case");
    expect(h.store.listTasks(run.id)[0]?.attempts).toBe(1);
  });

  it("fails a task after the fix-loop budget and reports it", async () => {
    h = await harness(script({ reviewer: () => ({ text: REQUEST_CHANGES }) }, planJson([{ key: "api" }])), { settings: { maxFixLoops: 1 } });
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.listTasks(run.id)[0]?.status).toBe("failed");
    expect(h.store.getRun(run.id)?.status).toBe("failed");
    expect(h.store.getRun(run.id)?.error).toMatch(/Nothing merged/);
  });

  it("waits at the approval gate and feeds a rejection comment back to the coder", async () => {
    h = await harness(script({}, planJson([{ key: "api" }])), { settings: { requireApproval: true } });
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    const first = (await h.next((m) => m.kind === "approval-updated" && m.approval.status === "pending")) as { approval: Approval };
    expect(h.store.getRun(run.id)?.status).toBe("awaiting-approval");
    expect(first.approval.branch).toMatch(/^appforge\//);
    // The diff shown to the human is available from git.
    const diff = await new GitRepo(h.dir).diffFiles("main", first.approval.branch);
    expect(diff.map((d) => d.path)).toEqual(["src/api.ts"]);

    h.orchestrator.decideApproval(first.approval.id, false, "Please rename x to todoCount");
    const second = (await h.next((m) => m.kind === "approval-updated" && m.approval.status === "pending" && m.approval.id !== first.approval.id)) as {
      approval: Approval;
    };
    expect(h.adapter.log.filter((c) => c.role === "coder").at(-1)?.prompt).toContain("Human reviewer: Please rename x to todoCount");
    h.orchestrator.decideApproval(second.approval.id, true);
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status).toBe("succeeded");
  });

  it("reverts writes outside a role's scope and runs tests between review and merge", async () => {
    let testRuns = 0;
    const testing: TestingService = {
      layout: () => ({ unit: "vitest", unitDir: "tests/", e2e: "none", e2eDir: "e2e/" }),
      runE2E: async () => [],
      runUnit: async ({ checkout }) => {
        testRuns++;
        const failing = testRuns === 1;
        const report: TestReport = {
          framework: "vitest",
          layer: "unit",
          cwd: path.basename(checkout),
          startedAt: new Date().toISOString(),
          durationMs: 1,
          total: 1,
          passed: failing ? 0 : 1,
          failed: failing ? 1 : 0,
          skipped: 0,
          cases: [{ name: "adds todos", status: failing ? "failed" : "passed", ...(failing ? { error: { message: "expected 1 to be 2" } } : {}) }],
        };
        return [report];
      },
    };
    h = await harness(
      script(
        {
          // The Test author tries to "fix" app code; that write must be reverted.
          "test-author": () => ({ text: "tests", files: { "tests/api.test.ts": "// t\n", "src/api.ts": "hacked\n" } }),
        },
        planJson([{ key: "api" }]),
      ),
      { settings: { unitBackend: "vitest" }, testing },
    );
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(await readFile(path.join(h.dir, "src/api.ts"), "utf8")).not.toContain("hacked");
    expect(existsSync(path.join(h.dir, "tests/api.test.ts"))).toBe(true);
    expect(h.store.logs.some((l) => /reverted src\/api\.ts/.test(l.message))).toBe(true);
    // First test run failed → coder got the structured failure.
    expect(h.adapter.log.filter((c) => c.role === "coder")[1]?.prompt).toContain("adds todos: expected 1 to be 2");
    // Task tests + the final full-suite run.
    expect(testRuns).toBe(3);
  });

  it("pauses on a plan limit and resumes the same step", async () => {
    let coderCalls = 0;
    h = await harness(
      script({ coder: (ctx) => (coderCalls++ === 0 ? { text: "", error: "You've hit your usage limit", rateLimited: true } : { text: "ok", files: { [`src/${taskKey(ctx.prompt)}.ts`]: "x\n" } }) }, planJson([{ key: "api" }])),
    );
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    await h.next((m) => runStatus(m, run.id, "paused"));
    expect(h.store.getRun(run.id)?.error).toMatch(/limit/);
    h.orchestrator.resumeRun(run.id);
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status).toBe("succeeded");
    expect(coderCalls).toBe(2);
  });

  it("stops a run and its agents", async () => {
    h = await harness(script({ coder: () => ({ text: "slow", delayMs: 5_000 }) }, planJson([{ key: "api" }])));
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    await h.next((m) => m.kind === "agent-event" && m.event.agentId === "coder-1");
    expect(h.orchestrator.stopRun(run.id)).toBe(true);
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status).toBe("cancelled");
    expect(h.store.listTasks(run.id)[0]?.status).toBe("cancelled");
  });

  it("stops when the budget is exceeded", async () => {
    h = await harness(script(), { settings: { budgetUsd: 0.5 } });
    // Scripted usage reports $0, so make every turn cost $1.
    const original = h.adapter.startSession.bind(h.adapter);
    h.adapter.startSession = async (opts) => {
      const s = await original(opts);
      return {
        id: s.id,
        stop: () => s.stop(),
        async *sendTask(prompt: string) {
          for await (const e of s.sendTask(prompt)) yield e.type === "usage" ? { ...e, costUsd: 1 } : e;
        },
      };
    };
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status).toBe("failed");
    expect(h.store.getRun(run.id)?.error).toMatch(/Budget/);
  });
});

describe("swarm mode", () => {
  it("runs coders in parallel worktrees up to the cap, with file ownership", async () => {
    let live = 0;
    let peak = 0;
    const plan = planJson([
      { key: "backend", files: ["src/backend/**"] },
      { key: "frontend", area: "frontend", files: ["src/frontend/**"] },
      { key: "auth", files: ["src/auth/**"] },
      { key: "docs", files: ["src/docs/**"], dependsOn: ["backend"] },
    ]);
    h = await harness(
      script(
        {
          coder: async (ctx) => {
            live++;
            peak = Math.max(peak, live);
            await new Promise((r) => setTimeout(r, 150));
            live--;
            const key = taskKey(ctx.prompt);
            // Every coder also touches a shared file it doesn't own; that must be reverted.
            return { text: "ok", files: { [`src/${key}/index.ts`]: `export const k = "${key}";\n`, "src/shared.ts": `// clobbered by ${key}\n` } };
          },
        },
        plan,
      ),
      { settings: { concurrency: 2 } },
    );
    const run = h.orchestrator.startRun(h.project.id, { mode: "swarm", brief: "backend, frontend and auth" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(peak).toBe(2);
    for (const key of ["backend", "frontend", "auth", "docs"]) {
      expect(await readFile(path.join(h.dir, `src/${key}/index.ts`), "utf8")).toContain(key);
    }
    expect(existsSync(path.join(h.dir, "src/shared.ts"))).toBe(false);
    // "docs" depended on "backend": it started only after backend merged.
    const coderOrder = h.adapter.log.filter((c) => c.role === "coder").map((c) => taskKey(c.prompt));
    expect(coderOrder.indexOf("docs")).toBeGreaterThan(coderOrder.indexOf("backend"));
    const tasks = h.store.listTasks(run.id);
    expect(new Set(tasks.map((t) => t.worktreePath)).size).toBe(4);
    expect(new Set(tasks.map((t) => t.branch)).size).toBe(4);
  });

  it("asks the Integrator to resolve merge conflicts", async () => {
    h = await harness(
      script(
        {
          coder: async (ctx) => {
            const key = taskKey(ctx.prompt);
            await new Promise((r) => setTimeout(r, key === "b" ? 100 : 10));
            return { text: "ok", files: { "src/routes.ts": `export const routes = ["${key}"];\n` } };
          },
          integrator: async (ctx): Promise<ScriptStep> => {
            if (!ctx.prompt.includes("Resolve merge conflicts")) return { text: "report", files: { "docs/REPORT.md": "# r\n" } };
            const text = await readFile(path.join(ctx.cwd, "src/routes.ts"), "utf8");
            expect(text).toContain("<<<<<<<");
            return { text: "resolved", files: { "src/routes.ts": 'export const routes = ["a", "b"];\n' } };
          },
        },
        planJson([{ key: "a" }, { key: "b" }]),
      ),
      { settings: { concurrency: 2 } },
    );
    const run = h.orchestrator.startRun(h.project.id, { mode: "swarm", brief: "two routes" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(await readFile(path.join(h.dir, "src/routes.ts"), "utf8")).toBe('export const routes = ["a", "b"];\n');
  });

  it("works across two separate repos", async () => {
    h = await harness(
      script(
        {
          coder: (ctx) => ({ text: "ok", files: { [`src/${taskKey(ctx.prompt)}.ts`]: "x\n" } }),
          integrator: () => ({ text: "report", files: { "docs/REPORT.md": "# r\n" } }),
        },
        planJson([
          { key: "api", area: "backend", files: ["backend/src/**"] },
          { key: "web", area: "frontend", files: ["frontend/src/**"] },
        ]),
      ),
      { shape: "separate" },
    );
    const run = h.orchestrator.startRun(h.project.id, { mode: "swarm", brief: "split" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(existsSync(path.join(h.dir, "backend/src/api.ts"))).toBe(true);
    expect(existsSync(path.join(h.dir, "frontend/src/web.ts"))).toBe(true);
    // The spec was copied into both repos and committed there.
    for (const repo of ["backend", "frontend"]) {
      expect(existsSync(path.join(h.dir, repo, "docs/SPEC.md"))).toBe(true);
      expect(await new GitRepo(path.join(h.dir, repo)).changedFiles()).toEqual([]);
    }
  });
});

describe("single mode", () => {
  it("lets you steer, then reviews and merges on finish", async () => {
    h = await harness(script({ coder: (ctx) => ({ text: `turn ${ctx.turn}`, files: { "notes.md": `turn ${ctx.turn}\n` } }) }));
    const run = h.orchestrator.startRun(h.project.id, { mode: "single", brief: "write notes" });
    await eventually(() => h!.orchestrator.sendCommand(run.id, { kind: "message", text: "add another line" }));
    await eventually(() => {
      if (h!.adapter.log.filter((c) => c.role === "coder").length < 2) throw new Error("second turn not started");
      h!.orchestrator.sendCommand(run.id, { kind: "finish" });
    });
    const pending = (await h.next((m) => m.kind === "approval-updated" && m.approval.status === "pending")) as { approval: Approval };
    h.orchestrator.decideApproval(pending.approval.id, true);
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status).toBe("succeeded");
    expect(await readFile(path.join(h.dir, "notes.md"), "utf8")).toBe("turn 1\n");
    // The second message continued the same session.
    expect(h.adapter.log.filter((c) => c.role === "coder").map((c) => c.turn)).toEqual([0, 1]);
  });
});

describe("restart recovery", () => {
  it("marks runs interrupted and resumes from saved tasks, honouring decisions made meanwhile", async () => {
    h = await harness(script({}, planJson([{ key: "api" }])), { settings: { requireApproval: true } });
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "api" });
    const pending = (await h.next((m) => m.kind === "approval-updated" && m.approval.status === "pending")) as { approval: Approval };

    // Simulate a restart: a fresh orchestrator over the same store.
    const { Orchestrator } = await import("../src/index.ts");
    const { ProviderRegistry } = await import("@appforge/providers");
    const fresh = new Orchestrator({ store: h.store, providers: new ProviderRegistry([h.adapter]), emit: () => {} });
    expect(fresh.recover()).toBe(1);
    expect(h.store.getRun(run.id)?.status).toBe("interrupted");
    fresh.decideApproval(pending.approval.id, true);
    fresh.resumeRun(run.id);
    await fresh.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(h.store.listTasks(run.id)[0]?.status).toBe("merged");
    // The architect did not run again.
    expect(h.adapter.log.filter((c) => c.role === "architect")).toHaveLength(1);
  });
});

describe("claude-native swarm", () => {
  it("hands the brief to a claude-code lead session, then reviews and merges", async () => {
    const lead = new ScriptedAdapter((ctx) => ({ text: "team done", files: { [`team-${ctx.turn}.md`]: "built by the team\n" } }), "claude-code", "Claude Code");
    h = await harness(script(), { extraAdapters: [lead] });
    const run = h.orchestrator.startRun(h.project.id, { mode: "swarm-native", brief: "build it as a team" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(lead.log[0]?.prompt).toContain("Create an agent team");
    expect(existsSync(path.join(h.dir, "team-0.md"))).toBe(true);
  });
});
