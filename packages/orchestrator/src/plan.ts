import type { ProjectShape, Task, TaskArea } from "@appforge/core";
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
  const warnings: string[] = [];
  const json = extractJson(text);
  const rawTasks = isRecord(json) && Array.isArray(json.tasks) ? json.tasks : Array.isArray(json) ? json : undefined;
  const summary = isRecord(json) && typeof json.summary === "string" ? json.summary : "";

  if (!rawTasks || rawTasks.length === 0) {
    warnings.push("The Architect did not return a task list; running the brief as a single task.");
    return { summary, warnings, tasks: [{ key: "main", title: firstLine(brief), description: brief, area: "shared", dependsOn: [], files: [], repo: repoForArea(shape, "shared") }] };
  }

  const tasks: PlannedTask[] = [];
  const seen = new Set<string>();
  for (const raw of rawTasks.filter(isRecord).slice(0, maxTasks)) {
    const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : `Task ${tasks.length + 1}`;
    let key = slugify(typeof raw.key === "string" && raw.key ? raw.key : title, 32);
    while (seen.has(key)) key = `${key}-${tasks.length + 1}`;
    seen.add(key);
    const area: TaskArea = typeof raw.area === "string" && AREAS.has(raw.area as TaskArea) ? (raw.area as TaskArea) : "shared";
    const repo = repoForArea(shape, area);
    const files = (Array.isArray(raw.files) ? raw.files : [])
      .filter((f): f is string => typeof f === "string" && f.trim() !== "")
      .map((f) => toRepoRelative(f.trim(), repo))
      .filter((f): f is string => f !== undefined);
    tasks.push({
      key,
      title,
      description: typeof raw.description === "string" && raw.description.trim() ? raw.description.trim() : title,
      area,
      dependsOn: (Array.isArray(raw.dependsOn) ? raw.dependsOn : []).filter((d): d is string => typeof d === "string").map((d) => slugify(d, 32)),
      files,
      repo,
    });
  }
  if (rawTasks.length > maxTasks) warnings.push(`The Architect proposed ${rawTasks.length} tasks; keeping the first ${maxTasks}.`);

  // Drop unknown/self dependencies, then break cycles.
  const keys = new Set(tasks.map((t) => t.key));
  for (const task of tasks) {
    const unknown = task.dependsOn.filter((d) => !keys.has(d) || d === task.key);
    if (unknown.length) warnings.push(`${task.key}: ignoring unknown dependencies ${unknown.join(", ")}`);
    task.dependsOn = [...new Set(task.dependsOn.filter((d) => keys.has(d) && d !== task.key))];
  }
  const cycle = findCycle(tasks);
  if (cycle) {
    warnings.push(`Dependency cycle ${cycle.join(" → ")}; running those tasks in listed order instead.`);
    const order = new Map(tasks.map((t, i) => [t.key, i]));
    for (const task of tasks) task.dependsOn = task.dependsOn.filter((d) => (order.get(d) ?? 0) < (order.get(task.key) ?? 0));
  }
  return { summary, tasks, warnings };
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
