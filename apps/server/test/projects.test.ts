import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Project } from "@appforge/core";
import { GitRepo } from "@appforge/workspace";
import { buildApp } from "../src/app.ts";

let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "appforge-srv-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("projects API", () => {
  it("creates a project in a chosen folder and lists it after a restart", async () => {
    const dataDir = path.join(tmp, "data");
    const folder = path.join(tmp, "work", "todo-app");

    let { app } = await buildApp({ dataDir });
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Todo", path: folder, shape: "monorepo", stackId: "node-react", scaffold: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const project = res.json<Project>();
    expect(project.repos).toEqual([{ path: ".", area: "shared" }]);
    expect(existsSync(path.join(folder, ".git"))).toBe(true);
    expect(existsSync(path.join(folder, "backend/src/app.ts"))).toBe(true);
    const repo = new GitRepo(folder);
    expect((await repo.log()).map((c) => c.message)[0]).toMatch(/scaffold/);
    expect(await repo.changedFiles()).toEqual([]);
    await app.close();

    ({ app } = await buildApp({ dataDir }));
    const list = (await app.inject({ method: "GET", url: "/api/projects" })).json<Project[]>();
    expect(list.map((p) => p.name)).toEqual(["Todo"]);
    expect(list[0]?.settings.unitBackend).toBe("vitest");
    await app.close();
  });

  it("creates two repos for the separate shape", async () => {
    const { app } = await buildApp({ dataDir: tmp, dbFile: ":memory:" });
    const folder = path.join(tmp, "shop");
    const res = await app.inject({
      method: "POST",
      url: "/api/projects",
      payload: { name: "Shop", path: folder, shape: "separate", stackId: "fastapi-react", scaffold: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    expect(existsSync(path.join(folder, "backend/.git"))).toBe(true);
    expect(existsSync(path.join(folder, "frontend/.git"))).toBe(true);
    expect(await readFile(path.join(folder, "backend/app/main.py"), "utf8")).toContain("FastAPI");
    expect(res.json<Project>().settings.unitBackend).toBe("pytest");
    await app.close();
  });

  it("rejects unsafe folders, duplicates and overlaps", async () => {
    const { app } = await buildApp({ dataDir: tmp, dbFile: ":memory:" });
    const bad = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "x", path: "/", shape: "monorepo", stackId: "node-react" } });
    expect(bad.statusCode).toBe(400);
    const home = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "x", path: os.homedir(), shape: "monorepo", stackId: "node-react" } });
    expect(home.statusCode).toBe(400);

    const folder = path.join(tmp, "a");
    const ok = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "a", path: folder, shape: "monorepo", stackId: "custom" } });
    expect(ok.statusCode).toBe(201);
    const nested = await app.inject({ method: "POST", url: "/api/projects", payload: { name: "b", path: path.join(folder, "sub"), shape: "monorepo", stackId: "custom" } });
    expect(nested.statusCode).toBe(400);
    expect(nested.json<{ error: string }>().error).toMatch(/overlaps/);
    await app.close();
  });

  it("updates settings with clamping", async () => {
    const { app } = await buildApp({ dataDir: tmp, dbFile: ":memory:" });
    const created = (
      await app.inject({ method: "POST", url: "/api/projects", payload: { name: "p", path: path.join(tmp, "p"), shape: "monorepo", stackId: "node-react" } })
    ).json<Project>();
    const res = await app.inject({
      method: "PATCH",
      url: `/api/projects/${created.id}`,
      payload: { settings: { concurrency: 99, e2e: "cypress", roles: { reviewer: { provider: "claude-code" } } } },
    });
    const updated = res.json<Project>();
    expect(updated.settings.concurrency).toBe(8);
    expect(updated.settings.e2e).toBe("cypress");
    expect(updated.settings.roles.reviewer.provider).toBe("claude-code");
    expect(updated.settings.roles.coder.provider).toBe("claude-code");
    await app.close();
  });
});

describe("folder browser and guards", () => {
  it("lists folders and creates new ones", async () => {
    const { app } = await buildApp({ dataDir: tmp, dbFile: ":memory:" });
    const mk = await app.inject({ method: "POST", url: "/api/fs/mkdir", payload: { parent: tmp, name: "newdir" } });
    expect(mk.statusCode).toBe(200);
    const list = (await app.inject({ method: "GET", url: `/api/fs/list?path=${encodeURIComponent(tmp)}` })).json<{ entries: { name: string }[] }>();
    expect(list.entries.map((e) => e.name)).toContain("newdir");
    const traversal = await app.inject({ method: "POST", url: "/api/fs/mkdir", payload: { parent: tmp, name: "../x" } });
    expect(traversal.statusCode).toBe(400);
    await app.close();
  });

  it("refuses non-local hosts and origins", async () => {
    const { app } = await buildApp({ dataDir: tmp, dbFile: ":memory:" });
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { host: "evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { origin: "https://evil.example" } })).statusCode).toBe(403);
    expect((await app.inject({ method: "GET", url: "/api/health", headers: { origin: "http://localhost:5173" } })).statusCode).toBe(200);
    await app.close();
  });
});
