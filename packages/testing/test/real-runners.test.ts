/**
 * Runs the real frameworks against small fixture projects. Needs network
 * access (npm/PyPI) and a Playwright Chromium, so it only runs with
 * APPFORGE_SLOW_TESTS=1.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Project } from "@appforge/core";
import { defaultProjectSettings } from "@appforge/core";
import { getStack, reposForShape, starterFiles } from "@appforge/templates";
import { GitRepo, ProcessRegistry } from "@appforge/workspace";
import { ProjectTesting, PytestRunner, VitestRunner } from "../src/index.ts";

const slow = process.env.APPFORGE_SLOW_TESTS === "1";
const processes = new ProcessRegistry();
const logs: string[] = [];
const log = (m: string) => logs.push(m);

let tmp: string;
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), "appforge-real-"));
});
afterAll(async () => {
  processes.killAll();
  await rm(tmp, { recursive: true, force: true });
});

async function write(dir: string, files: Record<string, string>) {
  for (const [rel, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), content);
  }
}

describe.skipIf(!slow)("real runners", () => {
  it("vitest: runs and reports pass/fail", async () => {
    const dir = path.join(tmp, "vitest");
    await write(dir, {
      "package.json": JSON.stringify({ name: "v", private: true, type: "module", devDependencies: { vitest: "^5.0.3" } }),
      "test/math.test.ts": `import { expect, test } from "vitest";\ntest("adds", () => expect(1 + 1).toBe(2));\ntest("breaks", () => expect(1 + 1).toBe(3));\n`,
      "e2e/ignored.spec.ts": `throw new Error("e2e specs must not run under vitest");\n`,
    });
    const report = await new VitestRunner(processes).run({ cwd: dir, log });
    expect(report, report.outputTail).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(report.cases.find((c) => c.status === "failed")?.error?.message).toMatch(/expected 2 to be 3/);
  });

  it("pytest: creates a venv and reports pass/fail", async () => {
    const dir = path.join(tmp, "pytest");
    await write(dir, {
      "requirements.txt": "",
      "tests/test_math.py": "def test_adds():\n    assert 1 + 1 == 2\n\ndef test_breaks():\n    assert 1 + 1 == 3\n",
    });
    const report = await new PytestRunner(processes).run({ cwd: dir, log });
    expect(report, report.outputTail).toMatchObject({ total: 2, passed: 1, failed: 1 });
    expect(existsSync(path.join(dir, ".venv"))).toBe(true);
  });

  it("switching Playwright ↔ Cypress changes what is scaffolded and run; Playwright runs against the live app", async () => {
    const dir = path.join(tmp, "app");
    const repo = await GitRepo.init(dir);
    const stack = getStack("node-react");
    await write(dir, starterFiles(stack, { projectName: "Todo" }));
    // Pin Playwright to the browser build available on this machine.
    const pkgPath = path.join(dir, "frontend/package.json");
    const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { devDependencies: Record<string, string> };
    pkg.devDependencies["@playwright/test"] = process.env.APPFORGE_PLAYWRIGHT_VERSION ?? "1.56.1";
    await writeFile(pkgPath, JSON.stringify(pkg, null, 2));
    await repo.commitAll("scaffold");

    const project: Project = {
      id: "p",
      name: "Todo",
      path: dir,
      shape: "monorepo",
      stackId: stack.id,
      repos: reposForShape("monorepo"),
      settings: defaultProjectSettings({ e2e: "playwright", unitBackend: "vitest", unitFrontend: "vitest" }),
      createdAt: new Date().toISOString(),
    };
    const testing = new ProjectTesting(processes);

    const playwrightFiles = await testing.scaffold(project, ["e2e"]);
    expect(playwrightFiles).toEqual(expect.arrayContaining(["frontend/playwright.config.ts", "frontend/e2e/smoke.spec.ts"]));
    const cypressFiles = await testing.scaffold({ ...project, settings: { ...project.settings, e2e: "cypress" } }, ["e2e"]);
    expect(cypressFiles).toEqual(expect.arrayContaining(["frontend/cypress.config.ts", "frontend/cypress/e2e/smoke.cy.ts"]));
    expect(JSON.parse(await readFile(pkgPath, "utf8")).devDependencies.cypress).toBeDefined();
    expect(await repo.changedFiles()).toEqual([]);

    // An E2E spec that needs both servers: the UI shows the backend's health status.
    await write(dir, {
      "frontend/e2e/api.spec.ts": `import { expect, test } from "@playwright/test";\ntest("shows API status", async ({ page }) => {\n  await page.goto("/");\n  await expect(page.getByTestId("api-status")).toHaveText("API: ok");\n});\n`,
      "backend/test/health.test.ts": `import request from "supertest";\nimport { expect, test } from "vitest";\nimport { createApp } from "../src/app.ts";\ntest("health", async () => {\n  const res = await request(createApp()).get("/api/health");\n  expect(res.body).toEqual({ status: "ok" });\n});\n`,
    });

    const unit = await testing.runUnit({ project, checkout: dir, repo: ".", area: "backend", signal: new AbortController().signal, log });
    expect(unit[0], unit[0]?.outputTail).toMatchObject({ framework: "vitest", cwd: "backend", passed: 1, failed: 0 });

    const e2e = await testing.runE2E({ project, signal: new AbortController().signal, log });
    expect(e2e[0], `${e2e[0]?.error}\n${e2e[0]?.outputTail}\n${logs.join("\n")}`).toMatchObject({ framework: "playwright", layer: "e2e", cwd: "frontend", failed: 0 });
    expect(e2e[0]?.passed, JSON.stringify(e2e[0], null, 1) + logs.join("\n")).toBe(2);
    expect(processes.size).toBe(0);
  });
});
