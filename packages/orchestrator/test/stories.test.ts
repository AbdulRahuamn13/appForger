import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Run, StoryPlan } from "@appforge/core";
import type { ScriptContext, ScriptStep } from "@appforge/providers";
import { GitRepo } from "@appforge/workspace";
import { parseStoryPlan, type ContextProvider } from "../src/index.ts";
import { APPROVE, harness, type Harness } from "./helpers.ts";

let h: Harness | undefined;
afterEach(async () => {
  if (h) {
    h.orchestrator.killAll();
    await h.cleanup();
  }
  h = undefined;
});

const PLAN_REPLY = `I read the code.
<summary>Add todos with a list page.</summary>
<spec>
# Todos
- GET /api/todos returns {"items": []}
- POST /api/todos
</spec>
<design>
Primary #111827, Inter 14/20, 8px grid. List page: header + card list.
</design>
<questions>
- Should completed todos be hidden?
- none
</questions>
\`\`\`json
{ "tasks": [
  { "key": "api", "title": "Todo API", "description": "CRUD endpoints", "area": "backend", "files": ["backend/src/**"] },
  { "key": "ui", "title": "Todo list UI", "description": "List + form", "area": "frontend", "dependsOn": ["api"], "files": ["frontend/src/**"] }
] }
\`\`\``;

describe("story plan parsing", () => {
  it("reads tagged sections and tasks", () => {
    const { plan, warnings } = parseStoryPlan(PLAN_REPLY, "Todos", 8, 2);
    expect(warnings).toEqual([]);
    expect(plan.summary).toBe("Add todos with a list page.");
    expect(plan.spec).toContain("GET /api/todos");
    expect(plan.design).toContain("#111827");
    expect(plan.questions).toEqual(["Should completed todos be hidden?"]);
    expect(plan.tasks.map((t) => [t.key, t.dependsOn, t.files])).toEqual([
      ["api", [], ["backend/src/**"]],
      ["ui", ["api"], ["frontend/src/**"]],
    ]);
    expect(plan.version).toBe(2);
  });

  it("falls back to the reply as spec when tags are missing", () => {
    const { plan, warnings } = parseStoryPlan("Just do it.", "Brief", 8, 1);
    expect(plan.spec).toBe("Just do it.");
    expect(plan.tasks).toHaveLength(1);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("plan-first stories", () => {
  it("plan mode proposes a plan without changing code, with context and images", async () => {
    const plans: StoryPlan[] = [];
    const finished: Run[] = [];
    const prepared: string[] = [];
    let imagePath = "";
    const context: ContextProvider = {
      systemAddendum: async (_p, role) => `## Skills\nskill-for-${role}`,
      prepare: async (_p, _run, cwd) => {
        prepared.push(cwd);
        const dir = path.join(cwd, ".appforge/context/images");
        await mkdir(dir, { recursive: true });
        imagePath = path.join(dir, "ref.png");
        await writeFile(imagePath, "png");
        await writeFile(path.join(cwd, ".appforge/context/PROJECT_CONTEXT.md"), "# History\n");
        return { images: [imagePath] };
      },
    };
    h = await harness((_ctx: ScriptContext): ScriptStep => ({ text: PLAN_REPLY, files: { "src/sneaky.ts": "written during planning" } }), {
      context,
      hooks: { onPlanReady: (_run, plan) => void plans.push(plan), onRunFinished: (run) => void finished.push(run) },
    });
    const run = h.orchestrator.startRun(h.project.id, { mode: "plan", brief: "Todos\nA todo list", acceptance: "- empty title is rejected", storyId: "story_1" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(h.store.getRun(run.id)?.storyId).toBe("story_1");
    expect(plans[0]?.tasks).toHaveLength(2);
    expect(finished.map((r) => r.status)).toEqual(["succeeded"]);
    // Planning is read-only: the write was reverted, and nothing was committed or tasked.
    expect(existsSync(path.join(h.dir, "src/sneaky.ts"))).toBe(false);
    expect(h.store.listTasks(run.id)).toEqual([]);
    const call = h.adapter.log[0] as ScriptContext;
    expect(call.role).toBe("architect");
    expect(call.prompt).toContain("plan only");
    expect(call.prompt).toContain("empty title is rejected");
    expect(call.prompt).toContain("you have reference images");
    expect(call.images).toEqual([imagePath]);
    expect(call.systemPrompt).toContain("skill-for-architect");
    expect(prepared).toContain(h.dir);
  });

  it("revises a plan with feedback", async () => {
    h = await harness(() => ({ text: PLAN_REPLY }));
    const { plan } = parseStoryPlan(PLAN_REPLY, "x", 8, 1);
    const run = h.orchestrator.startRun(h.project.id, { mode: "plan", brief: "Todos", previousPlan: plan, feedback: "Split the API into read and write tasks" });
    await h.orchestrator.waitFor(run.id);
    const prompt = h.adapter.log[0]?.prompt ?? "";
    expect(prompt).toContain("Previous plan (revise it)");
    expect(prompt).toContain("Split the API into read and write tasks");
  });

  it("executes an approved (edited) plan without re-planning, sharing acceptance criteria and images with UI agents only", async () => {
    let imagePath = "";
    const context: ContextProvider = {
      systemAddendum: async () => "",
      prepare: async (_p, _run, cwd) => {
        imagePath = path.join(cwd, ".appforge/context/images/ref.png");
        await mkdir(path.dirname(imagePath), { recursive: true });
        await writeFile(imagePath, "png");
        return { images: [imagePath] };
      },
    };
    h = await harness(
      (ctx) => {
        if (ctx.role === "reviewer") return { text: APPROVE };
        if (ctx.role === "integrator") return { text: "report", files: { "docs/REPORT.md": "# r\n" } };
        const key = /## Task: (.+)$/m.exec(ctx.prompt)?.[1] ?? "x";
        return { text: "done", files: { [`src/${key.replace(/\W+/g, "-")}.ts`]: "x\n" } };
      },
      { context },
    );
    const { plan } = parseStoryPlan(PLAN_REPLY, "x", 8, 1);
    const edited: StoryPlan = { ...plan, edited: true, tasks: plan.tasks.map((t) => (t.key === "ui" ? { ...t, title: "Todo list page (edited)" } : t)) };
    const run = h.orchestrator.startRun(h.project.id, { mode: "pipeline", brief: "Todos\nA todo list", plan: edited, acceptance: "- shows an empty state" });
    await h.orchestrator.waitFor(run.id);
    expect(h.store.getRun(run.id)?.status, h.store.logs.map((l) => l.message).join("\n")).toBe("succeeded");
    expect(h.adapter.log.some((c) => c.role === "architect")).toBe(false);
    expect(h.store.listTasks(run.id).map((t) => [t.key, t.title, t.status])).toEqual([
      ["api", "Todo API", "merged"],
      ["ui", "Todo list page (edited)", "merged"],
    ]);
    const spec = await readFile(path.join(h.dir, "docs/stories/todos.md"), "utf8");
    expect(spec).toContain("edited by hand");
    expect(spec).toContain("shows an empty state");
    expect(await new GitRepo(h.dir).changedFiles()).toEqual([]);
    const coders = h.adapter.log.filter((c) => c.role === "coder");
    expect(coders[0]?.prompt).toContain("docs/stories/todos.md");
    expect(coders[0]?.prompt).toContain("shows an empty state");
    expect(coders[0]?.images).toEqual([]); // backend task
    // Frontend task: the reference image, materialised inside its own worktree.
    expect(coders[1]?.images).toHaveLength(1);
    expect(coders[1]?.images[0]).toMatch(/\.appforge\/worktrees\/[^/]+-ui\/\.appforge\/context\/images\/ref\.png$/);
    expect(imagePath).toBeTruthy();
    expect(h.adapter.log.find((c) => c.role === "reviewer")?.prompt).toContain("shows an empty state");
  });

  it("single mode gets the approved plan in its brief", async () => {
    h = await harness(() => ({ text: "ok", files: { "a.txt": "a" } }));
    const { plan } = parseStoryPlan(PLAN_REPLY, "x", 8, 1);
    const run = h.orchestrator.startRun(h.project.id, { mode: "single", brief: "Todos", plan });
    await h.next((m) => m.kind === "run-updated" && m.run.id === run.id && m.run.status === "awaiting-input");
    expect(h.adapter.log[0]?.prompt).toContain("Approved plan (follow it)");
    h.orchestrator.stopRun(run.id);
    await h.orchestrator.waitFor(run.id);
  });
});
