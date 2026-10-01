import path from "node:path";
import type { ExecutionMode, PlannedTaskDraft, Run, Story, StoryPlan } from "@appforge/core";
import { EXECUTION_MODES, newId, nowIso, slugify, truncate } from "@appforge/core";
import type { Orchestrator } from "@appforge/orchestrator";
import { findCycle } from "@appforge/orchestrator";
import { GitRepo } from "@appforge/workspace";
import type { Store } from "./db/store.ts";
import type { Hub } from "./hub.ts";
import type { LogService, MemoryService } from "./logs.ts";

export class StoryError extends Error {}

export interface StoryInput {
  title?: string;
  body?: string;
  acceptance?: string;
  images?: string[];
}

const AREAS = new Set(["backend", "frontend", "shared"]);

/**
 * Stories are the unit of work: write one (or many), let the planner propose
 * a plan, edit/revise/approve it, pick how to build it, then read the log.
 */
export class StoryService {
  constructor(
    private readonly db: Store,
    private readonly hub: Hub,
    private readonly orchestrator: () => Orchestrator,
    private readonly logs: LogService,
    private readonly memory: MemoryService,
  ) {}

  private save(story: Story): Story {
    const next = { ...story, updatedAt: nowIso() };
    this.db.upsertStory(next);
    this.hub.broadcast({ kind: "story-updated", story: next });
    return next;
  }

  get(id: string): Story {
    const story = this.db.getStory(id);
    if (!story) throw new StoryError("Story not found");
    return story;
  }

  create(projectId: string, input: StoryInput): Story {
    if (!this.db.getProject(projectId)) throw new StoryError("Project not found");
    const title = input.title?.trim();
    if (!title) throw new StoryError("A story needs a title");
    const existing = this.db.listStories(projectId);
    const now = nowIso();
    return this.save({
      id: newId("story"),
      projectId,
      title,
      body: input.body?.trim() ?? "",
      acceptance: input.acceptance?.trim() ?? "",
      status: "draft",
      order: existing.length ? Math.max(...existing.map((s) => s.order)) + 1 : 0,
      images: this.validImages(projectId, input.images ?? []),
      planRunIds: [],
      runIds: [],
      createdAt: now,
      updatedAt: now,
    });
  }

  update(id: string, input: StoryInput & { plan?: StoryPlan }): Story {
    const story = this.get(id);
    if (story.status === "planning" || story.status === "running") throw new StoryError("Wait for the current run to finish (or stop it) before editing");
    const next: Story = { ...story };
    if (input.title !== undefined) {
      if (!input.title.trim()) throw new StoryError("A story needs a title");
      next.title = input.title.trim();
    }
    if (input.body !== undefined) next.body = input.body.trim();
    if (input.acceptance !== undefined) next.acceptance = input.acceptance.trim();
    if (input.images !== undefined) next.images = this.validImages(story.projectId, input.images);
    if (input.plan !== undefined) {
      if (!story.plan) throw new StoryError("There is no plan to edit yet");
      next.plan = { ...this.validPlan(input.plan), version: story.plan.version, createdAt: story.plan.createdAt, edited: true };
    }
    return this.save(next);
  }

  delete(id: string): void {
    const story = this.get(id);
    if (story.status === "planning" || story.status === "running") throw new StoryError("Stop the story's run before deleting it");
    this.db.deleteStory(id);
    this.hub.broadcast({ kind: "story-deleted", storyId: id, projectId: story.projectId });
  }

  reorder(projectId: string, ids: string[]): Story[] {
    const stories = this.db.listStories(projectId);
    ids.forEach((id, i) => {
      const s = stories.find((x) => x.id === id);
      if (s && s.order !== i) this.save({ ...s, order: i });
    });
    return this.db.listStories(projectId);
  }

  /** Ask the planner for a plan (or a revision with feedback). */
  plan(id: string, feedback?: string): Run {
    const story = this.get(id);
    if (story.status === "planning" || story.status === "running") throw new StoryError(`Story is already ${story.status}`);
    const revising = Boolean(feedback?.trim() && story.plan);
    const run = this.orchestrator().startRun(story.projectId, {
      mode: "plan",
      brief: this.brief(story),
      storyId: story.id,
      ...(story.acceptance ? { acceptance: story.acceptance } : {}),
      ...(revising && story.plan ? { previousPlan: story.plan, feedback: feedback?.trim() ?? "" } : {}),
    });
    this.save({ ...story, status: "planning", planRunIds: [...story.planRunIds, run.id] });
    return run;
  }

  /** Approve the current plan and build it in the chosen mode. */
  approve(id: string, mode: ExecutionMode, repo?: string): Run {
    const story = this.get(id);
    if (!(EXECUTION_MODES as readonly string[]).includes(mode)) throw new StoryError(`Mode must be one of ${EXECUTION_MODES.join(", ")}`);
    if (story.status !== "plan-review" && story.status !== "failed") throw new StoryError("Only a planned story can be approved");
    if (!story.plan) throw new StoryError("Plan the story first");
    const run = this.orchestrator().startRun(story.projectId, {
      mode,
      brief: this.brief(story),
      storyId: story.id,
      plan: story.plan,
      ...(story.acceptance ? { acceptance: story.acceptance } : {}),
      ...(repo ? { repo } : {}),
    });
    this.save({ ...story, status: "running", mode, runIds: [...story.runIds, run.id] });
    return run;
  }

  /** Undo a finished story: revert every merge its runs made, newest first. */
  async undo(id: string): Promise<{ reverted: number }> {
    const story = this.get(id);
    if (story.status !== "done" && story.status !== "failed") throw new StoryError("Only finished stories can be undone");
    const project = this.db.getProject(story.projectId);
    if (!project) throw new StoryError("Project not found");
    if (this.orchestrator().hasActiveRuns(project.id)) throw new StoryError("Stop the project's active runs first");
    const merges: { repo: string; branch: string; at: string }[] = [];
    for (const runId of story.runIds) {
      for (const t of this.db.listTasks(runId)) if (t.status === "merged" && t.branch) merges.push({ repo: t.repo, branch: t.branch, at: t.updatedAt });
    }
    if (!merges.length) throw new StoryError("This story merged nothing, so there is nothing to undo");
    let reverted = 0;
    for (const m of merges.sort((a, b) => b.at.localeCompare(a.at))) {
      const repo = new GitRepo(path.join(project.path, m.repo));
      if ((await repo.changedFiles()).length) throw new StoryError(`Commit or stash the changes in ${m.repo === "." ? "the project folder" : m.repo} first`);
      const sha = await repo.findMergeCommit(m.branch);
      if (!sha) continue;
      try {
        await repo.revert(sha, true);
      } catch (err) {
        throw new StoryError((err as Error).message);
      }
      reverted++;
    }
    this.save({ ...story, status: "reverted", outcome: `Undone: reverted ${reverted} merge(s) on ${nowIso().slice(0, 16)}` });
    await this.memory.append(project.id, `## ${nowIso().slice(0, 10)} — Undid "${story.title}"\nReverted ${reverted} merge(s); the code from this story is no longer on the base branch.`);
    return { reverted };
  }

  /** Orchestrator hook: a plan is ready for review. */
  onPlanReady(run: Run, plan: StoryPlan): void {
    if (!run.storyId) return;
    const story = this.db.getStory(run.storyId);
    if (!story) return;
    this.save({ ...story, plan, status: "plan-review", outcome: `Plan v${plan.version} ready for review` });
  }

  /** Orchestrator hook: save the log, update the story, remember the outcome. */
  async onRunFinished(run: Run): Promise<void> {
    const logName = await this.logs.save(run.id);
    if (!run.storyId) return;
    const story = this.db.getStory(run.storyId);
    if (!story) return;
    if (run.mode === "plan") {
      if (run.status === "succeeded") return; // onPlanReady already moved it to plan-review
      const back = story.plan ? "plan-review" : "draft";
      this.save({ ...story, status: back, outcome: run.status === "cancelled" ? "Planning stopped" : `Planning failed: ${truncate(run.error ?? "", 200)}` });
      return;
    }
    const tasks = this.db.listTasks(run.id);
    const merged = tasks.filter((t) => t.status === "merged").length;
    if (run.status === "succeeded") {
      this.save({ ...story, status: "done", outcome: `Built with ${run.mode}: ${merged}/${tasks.length} task(s) merged` });
    } else if (run.status === "cancelled") {
      this.save({ ...story, status: "plan-review", outcome: "Run stopped; approve the plan again to retry" });
    } else {
      this.save({ ...story, status: "failed", outcome: truncate(run.error ?? "Run failed", 240) });
    }
    await this.memory.append(
      story.projectId,
      [
        `## ${nowIso().slice(0, 10)} — ${story.title} (${run.status})`,
        story.plan ? `Plan: ${story.plan.summary}` : "",
        `Mode: ${run.mode}; ${merged}/${tasks.length} task(s) merged.${run.error ? ` Problem: ${truncate(run.error, 300)}` : ""}`,
        logName ? `Log: ${logName}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }

  private brief(story: Story): string {
    return `${story.title}\n${story.body}`.trim();
  }

  private validImages(projectId: string, ids: string[]): string[] {
    return [...new Set(ids)].filter((id) => this.db.getAsset(id)?.projectId === projectId);
  }

  /** Check a hand-edited plan: tidy keys, known dependencies, no cycles. */
  private validPlan(plan: StoryPlan): Omit<StoryPlan, "version" | "createdAt"> {
    if (!Array.isArray(plan.tasks) || plan.tasks.length === 0) throw new StoryError("A plan needs at least one task");
    const seen = new Set<string>();
    const tasks: PlannedTaskDraft[] = plan.tasks.map((t, i) => {
      if (!t.title?.trim()) throw new StoryError(`Task ${i + 1} needs a title`);
      let key = slugify(t.key || t.title, 32);
      while (seen.has(key)) key = `${key}-${i + 1}`;
      seen.add(key);
      return {
        key,
        title: t.title.trim(),
        description: (t.description ?? "").trim() || t.title.trim(),
        area: AREAS.has(t.area) ? t.area : "shared",
        dependsOn: (t.dependsOn ?? []).map((d) => slugify(d, 32)),
        files: (t.files ?? []).map((f) => f.trim()).filter(Boolean),
      };
    });
    for (const t of tasks) {
      const unknown = t.dependsOn.filter((d) => !seen.has(d) || d === t.key);
      if (unknown.length) throw new StoryError(`${t.key} depends on unknown task(s): ${unknown.join(", ")}`);
    }
    const cycle = findCycle(tasks);
    if (cycle) throw new StoryError(`Tasks depend on each other in a loop: ${cycle.join(" → ")}`);
    return {
      summary: (plan.summary ?? "").trim(),
      spec: (plan.spec ?? "").trim(),
      ...(plan.design?.trim() ? { design: plan.design.trim() } : {}),
      questions: (plan.questions ?? []).map((q) => q.trim()).filter(Boolean),
      tasks,
    };
  }
}
