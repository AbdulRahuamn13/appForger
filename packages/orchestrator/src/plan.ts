import type { PlannedTaskDraft, ProjectShape, StoryPlan, Task, TaskArea } from "@appforge/core";
import { extractJson, isRecord, slugify } from "@appforge/core";
import { locatePart } from "@appforge/templates";

export interface PlannedTask {
  key: string;
  title: string;
  description: string;
  area: TaskArea;
  dependsOn: string[];
  /** Ownership globs relative to the task's repo. */
  files: string[];
  repo: string;
}

export interface Plan {
  summary: string;
  tasks: PlannedTask[];
  warnings: string[];
}

const AREAS = new Set<TaskArea>(["backend", "frontend", "shared"]);

/** Which repo (relative to the project folder) a task of this area changes. */
export function repoForArea(shape: ProjectShape, area: TaskArea): string {
  if (shape === "monorepo") return ".";
  return locatePart(shape, area === "frontend" ? "frontend" : "backend").repo;
}

/**
 * Turn the Architect's reply into a validated task list. Bad or missing JSON
 * falls back to a single task containing the whole brief, so a run can still
 * make progress.
 */
export function parsePlan(text: string, brief: string, shape: ProjectShape, maxTasks: number): Plan {
  const json = extractJson(text);
  const summary = isRecord(json) && typeof json.summary === "string" ? json.summary : "";
  const { drafts, warnings } = parseDrafts(json, brief, maxTasks);
  return { summary, warnings, tasks: toPlannedTasks(drafts, shape) };
}

/**
 * Normalise raw task objects (from the Architect, or edited by the human)
 * into drafts with project-relative ownership: unique keys, known
 * dependencies, no cycles.
 */
export function parseDrafts(json: unknown, brief: string, maxTasks: number): { drafts: PlannedTaskDraft[]; warnings: string[] } {
  const warnings: string[] = [];
  const rawTasks = isRecord(json) && Array.isArray(json.tasks) ? json.tasks : Array.isArray(json) ? json : undefined;
  if (!rawTasks || rawTasks.length === 0) {
    warnings.push("The Architect did not return a task list; running the brief as a single task.");
    return { warnings, drafts: [{ key: "main", title: firstLine(brief), description: brief, area: "shared", dependsOn: [], files: [] }] };
  }
  const drafts: PlannedTaskDraft[] = [];
  const seen = new Set<string>();
  for (const raw of rawTasks.filter(isRecord).slice(0, maxTasks)) {
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : `Task ${drafts.length + 1}`;
    let key = slugify(typeof raw.key === "string" && raw.key ? raw.key : title, 32);
    while (seen.has(key)) key = `${key}-${drafts.length + 1}`;
    seen.add(key);
    const area: TaskArea = typeof raw.area === "string" && AREAS.has(raw.area as TaskArea) ? (raw.area as TaskArea) : "shared";
    drafts.push({
      key,
      title,
      description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : title,
      area,
      dependsOn: (Array.isArray(raw.dependsOn) ? raw.dependsOn : []).filter((d): d is string => typeof d === "string").map((d) => slugify(d, 32)),
      files: (Array.isArray(raw.files) ? raw.files : []).filter((f): f is string => typeof f === "string" && f.trim() !== "").map((f) => f.trim().replace(/^\.\//, "")),
    });
  }
  if (rawTasks.length > maxTasks) warnings.push(`The Architect proposed ${rawTasks.length} tasks; keeping the first ${maxTasks}.`);

  // Drop unknown/self dependencies, then break cycles.
  const keys = new Set(drafts.map((t) => t.key));
  for (const task of drafts) {
    const unknown = task.dependsOn.filter((d) => !keys.has(d) || d === task.key);
    if (unknown.length) warnings.push(`${task.key}: ignoring unknown dependencies ${unknown.join(", ")}`);
    task.dependsOn = [...new Set(task.dependsOn.filter((d) => keys.has(d) && d !== task.key))];
  }
  const cycle = findCycle(drafts);
  if (cycle) {
    warnings.push(`Dependency cycle ${cycle.join(" → ")}; running those tasks in listed order instead.`);
    const order = new Map(drafts.map((t, i) => [t.key, i]));
    for (const task of drafts) task.dependsOn = task.dependsOn.filter((d) => (order.get(d) ?? 0) < (order.get(task.key) ?? 0));
  }
  return { drafts, warnings };
}

/** Place drafts in their repos and make ownership repo-relative. */
export function toPlannedTasks(drafts: PlannedTaskDraft[], shape: ProjectShape): PlannedTask[] {
  return drafts.map((d) => {
    const repo = repoForArea(shape, d.area);
    return {
      ...d,
      repo,
      files: d.files.map((f) => toRepoRelative(f, repo)).filter((f): f is string => f !== undefined),
    };
  });
}

/** Read a story-planning reply (<summary>, <spec>, <design>, <questions>, tasks JSON) into a StoryPlan. */
export function parseStoryPlan(text: string, brief: string, maxTasks: number, version: number): { plan: StoryPlan; warnings: string[] } {
  const tag = (name: string) => new RegExp(`<${name}>\\s*([\\s\\S]*?)\\s*</${name}>`, "i").exec(text)?.[1]?.trim() ?? "";
  // Only look for the JSON after the tagged sections, so braces in the spec don't confuse it.
  const lastTag = Math.max(text.lastIndexOf("</questions>"), text.lastIndexOf("</design>"), text.lastIndexOf("</spec>"));
  const json = extractJson(lastTag > 0 ? text.slice(lastTag) : text);
  const { drafts, warnings } = parseDrafts(json, brief, maxTasks);
  let spec = tag("spec");
  if (!spec) {
    warnings.push("The planner did not return a <spec> section; using its whole reply as the spec.");
    spec = text.replace(/```json[\s\S]*?```/g, "").trim();
  }
  const design = tag("design");
  const questions = tag("questions")
    .split("\n")
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, "").trim())
    .filter((l) => l && !/^(none|n\/a|no questions)\.?$/i.test(l));
  const summary = tag("summary") || (isRecord(json) && typeof json.summary === "string" ? json.summary : firstLine(spec));
  return {
    plan: { summary, spec, ...(design && !/^(none|n\/a)\.?$/i.test(design) ? { design } : {}), questions, tasks: drafts, version, createdAt: new Date().toISOString() },
    warnings,
  };
}

/** Ownership globs come relative to the project folder; make them relative to the task's repo. */
function toRepoRelative(glob: string, repo: string): string | undefined {
  const clean = glob.replace(/^\.\//, "");
  if (repo === ".") return clean;
  if (clean.startsWith(`${repo}/`)) return clean.slice(repo.length + 1);
  // A glob for the other repo can't be owned from this one.
  if (/^(backend|frontend)\//.test(clean)) return undefined;
  return clean;
}

export function findCycle(tasks: Pick<PlannedTask, "key" | "dependsOn">[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn]));
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (key: string): string[] | undefined => {
    if (state.get(key) === "done") return undefined;
    if (state.get(key) === "visiting") return [...stack.slice(stack.indexOf(key)), key];
    state.set(key, "visiting");
    stack.push(key);
    for (const d of deps.get(key) ?? []) {
      const found = visit(d);
      if (found) return found;
    }
    stack.pop();
    state.set(key, "done");
    return undefined;
  };
  for (const t of tasks) {
    const found = visit(t.key);
    if (found) return found;
  }
  return undefined;
}

/** Tasks in an order where every dependency comes first (stable w.r.t. `order`). */
export function topoOrder<T extends Pick<Task, "key" | "dependsOn" | "order">>(tasks: T[]): T[] {
  const byKey = new Map(tasks.map((t) => [t.key, t]));
  const out: T[] = [];
  const done = new Set<string>();
  const visit = (t: T, path: Set<string>) => {
    if (done.has(t.key) || path.has(t.key)) return;
    path.add(t.key);
    for (const d of t.dependsOn) {
      const dep = byKey.get(d);
      if (dep) visit(dep, path);
    }
    done.add(t.key);
    out.push(t);
  };
  for (const t of [...tasks].sort((a, b) => a.order - b.order)) visit(t, new Set());
  return out;
}

function firstLine(text: string): string {
  const line = text.split("\n").find((l) => l.trim())?.trim() ?? "Build the brief";
  return line.length > 80 ? `${line.slice(0, 77)}…` : line;
}
