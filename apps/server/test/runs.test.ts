import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Approval, FileDiff, Project, Run, ServerMessage, Task, UsageSummary } from "@appforge/core";
import { createDemoAdapter, MemorySecretStore, ProviderRegistry } from "@appforge/providers";
import { buildApp } from "../src/app.ts";

let tmp: string;
beforeEach(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "appforge-runs-"));
});
afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const demoRoles = {
  architect: { provider: "demo" },
  coder: { provider: "demo" },
  reviewer: { provider: "demo" },
  "test-author": { provider: "demo" },
  integrator: { provider: "demo" },
};

describe("runs API", () => {
  it("takes a brief from spec to merged code through the approval gate", async () => {
    const { app, ctx } = await buildApp({
      dataDir: tmp,
      dbFile: ":memory:",
      secrets: new MemorySecretStore(),
      providers: new ProviderRegistry([createDemoAdapter()]),
    });
    const messages: ServerMessage[] = [];
    ctx.hub.subscribe((m) => messages.push(m));
    const waitFor = async (pred: (m: ServerMessage) => boolean, timeout = 20_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const hit = messages.find(pred);
        if (hit) return hit;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error("timeout");
    };

    const project = (
      await app.inject({
        method: "POST",
        url: "/api/projects",
        payload: {
          name: "Todo",
          path: path.join(tmp, "todo"),
          shape: "monorepo",
          stackId: "node-react",
          scaffold: true,
          settings: { roles: demoRoles, unitBackend: "none", unitFrontend: "none", e2e: "none", requireApproval: true },
        },
      })
    ).json<Project>();

    const bad = await app.inject({ method: "POST", url: `/api/projects/${project.id}/runs`, payload: { mode: "nope", brief: "x" } });
    expect(bad.statusCode).toBe(400);

    const created = await app.inject({ method: "POST", url: `/api/projects/${project.id}/runs`, payload: { mode: "pipeline", brief: "todo API + React list" } });
    expect(created.statusCode, created.body).toBe(201);
    const run = created.json<Run>();

    // Approve every task as it reaches the gate, after checking its diff.
    const approved = new Set<string>();
    while (true) {
      const done = messages.find((m) => m.kind === "run-updated" && m.run.id === run.id && ["succeeded", "failed", "cancelled"].includes(m.run.status));
      if (done) break;
      const pending = messages.find(
        (m): m is Extract<ServerMessage, { kind: "approval-updated" }> => m.kind === "approval-updated" && m.approval.status === "pending" && !approved.has(m.approval.id),
      );
      if (pending) {
        const diff = (await app.inject({ method: "GET", url: `/api/approvals/${pending.approval.id}/diff` })).json<FileDiff[]>();
        expect(diff.length).toBeGreaterThan(0);
        const res = await app.inject({ method: "POST", url: `/api/approvals/${pending.approval.id}`, payload: { approved: true } });
        expect(res.json<Approval>().status).toBe("approved");
        approved.add(pending.approval.id);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    await waitFor((m) => m.kind === "run-updated" && m.run.id === run.id && m.run.status === "succeeded");

    const detail = (await app.inject({ method: "GET", url: `/api/runs/${run.id}` })).json<{ run: Run; tasks: Task[]; approvals: Approval[] }>();
    expect(detail.tasks.map((t) => t.status)).toEqual(["merged", "merged", "merged"]);
    expect(detail.approvals).toHaveLength(3);
    expect(existsSync(path.join(project.path, "backend/src/routes/build-the-backend-api.ts"))).toBe(true);
    expect(existsSync(path.join(project.path, "docs/REPORT.md"))).toBe(true);

    const usage = (await app.inject({ method: "GET", url: `/api/runs/${run.id}/usage` })).json<UsageSummary[]>();
    expect(usage.map((u) => u.role)).toContain("architect");
    const events = (await app.inject({ method: "GET", url: `/api/runs/${run.id}/events` })).json<unknown[]>();
    expect(events.length).toBeGreaterThan(10);
    expect((await app.inject({ method: "GET", url: `/api/projects/${project.id}/runs` })).json<Run[]>()).toHaveLength(1);
    await app.close();
  }, 60_000);
});
