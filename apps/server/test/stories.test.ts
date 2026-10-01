import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Asset, LogFileInfo, Project, Run, Skill, Story } from "@appforge/core";
import { createDemoAdapter, MemorySecretStore, ProviderRegistry } from "@appforge/providers";
import { MemoryBlobStore } from "@appforge/storage";
import { buildApp, type Built } from "../src/app.ts";

let tmp: string;
let built: Built | undefined;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "appforge-stories-"));
});
afterEach(async () => {
  await built?.app.close();
  built = undefined;
  await rm(tmp, { recursive: true, force: true });
});

const roles = Object.fromEntries(["architect", "coder", "reviewer", "test-author", "integrator"].map((r) => [r, { provider: "demo" }]));
// 1x1 PNG
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

async function setup() {
  built = await buildApp({ dataDir: tmp, dbFile: ":memory:", secrets: new MemorySecretStore(), providers: new ProviderRegistry([createDemoAdapter()]), blobStore: new MemoryBlobStore() });
  const { app } = built;
  const project = (
    await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Todo", path: path.join(tmp, "todo"), shape: "monorepo", stackId: "node-react", scaffold: true, settings: { roles, unitBackend: "none", unitFrontend: "none", e2e: "none", requireApproval: false } },
    })
  ).json<Project>();
  return { app, project };
}

async function waitStory(id: string, statuses: Story["status"][], timeout = 30_000): Promise<Story> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const res = await built!.app.inject({ method: "GET", url: `/api/stories/${id}` });
    const story = res.json<{ story: Story }>().story;
    if (statuses.includes(story.status)) return story;
    if (Date.now() > deadline) throw new Error(`story stuck in ${story.status}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("stories: plan → review/edit → choose mode → build → log", () => {
  it("runs the whole loop for multiple stories on one project", async () => {
    const { app, project } = await setup();

    const asset = (
      await app.inject({ method: "POST", url: `/api/projects/${project.id}/assets`, payload: { name: "home.png", mediaType: "image/png", dataBase64: PNG } })
    ).json<Asset>();
    expect(asset.size).toBeGreaterThan(0);
    expect((await app.inject({ method: "GET", url: `/api/assets/${asset.id}` })).headers["content-type"]).toBe("image/png");
    expect((await app.inject({ method: "POST", url: `/api/projects/${project.id}/assets`, payload: { name: "x.exe", mediaType: "application/x-msdownload", dataBase64: "AA==" } })).statusCode).toBe(400);

    const created = await app.inject({
      method: "POST",
      url: `/api/projects/${project.id}/stories`,
      payload: { title: "Todo list", body: "Users can add and list todos", acceptance: "- empty titles are rejected", images: [asset.id] },
    });
    expect(created.statusCode, created.body).toBe(201);
    const story = created.json<Story>();
    expect(story).toMatchObject({ status: "draft", images: [asset.id] });
    const second = (await app.inject({ method: "POST", url: `/api/projects/${project.id}/stories`, payload: { title: "Due dates" } })).json<Story>();
    expect(second.order).toBe(1);

    // 1. Plan (no code changes)
    expect((await app.inject({ method: "POST", url: `/api/stories/${story.id}/plan`, payload: {} })).statusCode).toBe(200);
    let planned = await waitStory(story.id, ["plan-review"]);
    expect(planned.plan?.version).toBe(1);
    expect(planned.plan?.design).toMatch(/reference image/);
    expect(planned.plan?.questions.length).toBe(1);
    expect(planned.plan?.tasks).toHaveLength(2);
    // The planner got project context.
    expect(await readFile(path.join(project.path, ".appforge/context/PROJECT_CONTEXT.md"), "utf8")).toContain("Todo list ← current");

    // 2. Edit the plan by hand (and reject bad edits)
    const bad = await app.inject({ method: "PATCH", url: `/api/stories/${story.id}`, payload: { plan: { ...planned.plan, tasks: [{ ...planned.plan!.tasks[0], dependsOn: ["nope"] }] } } });
    expect(bad.statusCode).toBe(400);
    const tasks = planned.plan!.tasks.map((t, i) => (i === 1 ? { ...t, title: "Todo list page" } : t));
    const edited = (await app.inject({ method: "PATCH", url: `/api/stories/${story.id}`, payload: { plan: { ...planned.plan, tasks } } })).json<Story>();
    expect(edited.plan).toMatchObject({ edited: true, version: 1 });

    // 3. Ask the planner to revise with feedback
    await app.inject({ method: "POST", url: `/api/stories/${story.id}/plan`, payload: { feedback: "Keep the list sorted newest first" } });
    planned = await waitStory(story.id, ["plan-review"]);
    expect(planned.plan?.version).toBe(2);
    expect(planned.plan?.summary).toContain("revised");

    // 4. Approve and choose the mode
    expect((await app.inject({ method: "POST", url: `/api/stories/${story.id}/approve`, payload: { mode: "teleport" } })).statusCode).toBe(400);
    const run = (await app.inject({ method: "POST", url: `/api/stories/${story.id}/approve`, payload: { mode: "swarm" } })).json<Run>();
    expect(run).toMatchObject({ mode: "swarm", storyId: story.id });
    const done = await waitStory(story.id, ["done", "failed"]);
    expect(done.status, done.outcome).toBe("done");
    expect(done.outcome).toMatch(/2\/2 task/);
    expect(existsSync(path.join(project.path, "docs/stories/todo-list.md"))).toBe(true);

    // 5. Logs: one text file per run, viewable and downloadable
    await new Promise((r) => setTimeout(r, 200));
    const logs = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/logs` })).json<LogFileInfo[]>();
    expect(logs).toHaveLength(3);
    expect(logs[0]?.name).toMatch(/_swarm_todo-list_/);
    const log = await app.inject({ method: "GET", url: `/api/projects/${project.id}/logs/${logs[0]?.name}` });
    expect(log.body).toContain("Story:    Todo list");
    expect(log.body).toContain("Plan v2");
    expect(log.body).toContain("Timeline");
    expect(log.body).toContain("[coder-1]");
    const download = await app.inject({ method: "GET", url: `/api/projects/${project.id}/logs/${logs[0]?.name}?download=1` });
    expect(download.headers["content-disposition"]).toContain("attachment");
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/logs/..%2F..%2Fsecret.txt` })).statusCode).toBe(404);
    const all = await app.inject({ method: "GET", url: `/api/projects/${project.id}/logs-all` });
    expect(all.body.match(/########## /g)).toHaveLength(3);

    // 6. Memory records the outcome; the next story's agents see history
    const memory = (await app.inject({ method: "GET", url: `/api/projects/${project.id}/memory` })).json<{ text: string }>().text;
    expect(memory).toContain("Todo list (succeeded)");
    await app.inject({ method: "POST", url: `/api/stories/${second.id}/plan`, payload: {} });
    await waitStory(second.id, ["plan-review"]);
    const context = await readFile(path.join(project.path, ".appforge/context/PROJECT_CONTEXT.md"), "utf8");
    expect(context).toContain("[done] Todo list");
    expect(context).toContain("Todo list (succeeded)");
    expect(existsSync(path.join(project.path, ".appforge/context/logs", logs[0]?.name ?? "x"))).toBe(true);

    // 7. Undo the first story
    const undo = await app.inject({ method: "POST", url: `/api/stories/${story.id}/undo` });
    expect(undo.json<{ reverted: number }>().reverted).toBe(2);
    expect((await waitStory(story.id, ["reverted"])).outcome).toMatch(/reverted 2 merge/);
    expect(existsSync(path.join(project.path, "frontend/src/features"))).toBe(false);
  }, 120_000);
});

describe("skills, storage settings and doctor", () => {
  it("manages skills and switches storage with a copy", async () => {
    const { app } = await setup();
    const skills = (await app.inject({ method: "GET", url: "/api/skills" })).json<Skill[]>();
    expect(skills.some((s) => s.id === "verify-before-done")).toBe(true);
    const created = await app.inject({ method: "POST", url: "/api/skills", payload: { name: "Use Zod", description: "validation", roles: ["coder"], body: "Validate with zod." } });
    expect(created.json<Skill>().id).toBe("use-zod");
    const imported = await app.inject({ method: "POST", url: "/api/skills/import", payload: { markdown: "---\nname: Commit style\n---\nUse conventional commits." } });
    expect(imported.json<{ imported: Skill[] }>().imported[0]?.id).toBe("commit-style");

    const before = (await app.inject({ method: "GET", url: "/api/settings/storage" })).json<{ settings: { mode: string }; active: string }>();
    expect(before.settings.mode).toBe("local");
    const target = path.join(tmp, "elsewhere");
    const switched = await app.inject({
      method: "PUT",
      url: "/api/settings/storage",
      payload: { settings: { ...before.settings, mode: "local", local: { path: target } }, copy: true },
    });
    expect(switched.statusCode, switched.body).toBe(200);
    expect(switched.json<{ copied: number }>().copied).toBeGreaterThanOrEqual(2);
    expect(existsSync(path.join(target, "skills/use-zod/SKILL.md"))).toBe(true);
    const cloud = await app.inject({ method: "PUT", url: "/api/settings/storage", payload: { settings: { ...before.settings, mode: "cloud", cloud: { region: "auto", bucket: "b", prefix: "", forcePathStyle: true } } } });
    expect(cloud.statusCode).toBe(400);
    expect(cloud.json<{ error: string }>().error).toMatch(/access key/);

    const doctor = (await app.inject({ method: "GET", url: "/api/doctor" })).json<{ name: string; ok: boolean }[]>();
    expect(doctor.find((c) => c.name === "git")?.ok).toBe(true);
    expect(doctor.find((c) => c.name === "Storage")?.ok).toBe(true);
  });
});
