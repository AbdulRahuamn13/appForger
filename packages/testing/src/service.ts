import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Project, TaskArea, TestFramework, TestReport, TestRunnerAdapter } from "@appforge/core";
import { tail } from "@appforge/core";
import type { E2ETestRequest, TestingService, UnitTestRequest } from "@appforge/orchestrator";
import { getStack, locatePart, type StackPart } from "@appforge/templates";
import { findFreePort, GitRepo, waitForHttp, type ProcessRegistry } from "@appforge/workspace";
import { CypressRunner } from "./adapters/cypress.ts";
import { JestRunner } from "./adapters/jest.ts";
import { PlaywrightRunner } from "./adapters/playwright.ts";
import { PytestRunner } from "./adapters/pytest.ts";
import { VitestRunner } from "./adapters/vitest.ts";
import { XunitRunner } from "./adapters/xunit.ts";
import { ensureNodeDeps, ensurePythonVenv, venvPython } from "./base.ts";
import { emptyReport } from "./parsers.ts";

type Part = StackPart["area"];

export function createRunners(processes: ProcessRegistry): Record<TestFramework, TestRunnerAdapter> {
  return {
    vitest: new VitestRunner(processes),
    jest: new JestRunner(processes),
    pytest: new PytestRunner(processes),
    xunit: new XunitRunner(processes),
    playwright: new PlaywrightRunner(processes),
    cypress: new CypressRunner(processes),
  };
}

const UNIT_DIRS: Record<string, string> = { vitest: "test/", jest: "__tests__/", pytest: "tests/", xunit: "Api.Tests/" };
const E2E_DIRS: Record<string, string> = { playwright: "e2e/", cypress: "cypress/e2e/" };

/**
 * The orchestrator's view of testing for a project: which framework runs
 * where, how to start the app for E2E, and how to scaffold the chosen
 * frameworks. The orchestrator (not an agent) runs every test.
 */
export class ProjectTesting implements TestingService {
  readonly runners: Record<TestFramework, TestRunnerAdapter>;

  constructor(private readonly processes: ProcessRegistry) {
    this.runners = createRunners(processes);
  }

  private unitFramework(project: Project, part: Part) {
    return part === "backend" ? project.settings.unitBackend : project.settings.unitFrontend;
  }

  /** Absolute folder of a stack part inside a given checkout of its repo. */
  private partDir(project: Project, part: Part, checkout?: string): string {
    const { repo, dirInRepo } = locatePart(project.shape, part);
    return path.join(checkout ?? path.join(project.path, repo), dirInRepo);
  }

  layout(project: Project, area: TaskArea) {
    const parts: Part[] = area === "shared" ? ["backend", "frontend"] : [area];
    const prefix = (part: Part) => (project.shape === "monorepo" ? `${part}/` : "");
    const unit = parts.map((p) => `${this.unitFramework(project, p)} (${p})`).join(" and ");
    const unitDir = parts.map((p) => `${prefix(p)}${UNIT_DIRS[this.unitFramework(project, p)] ?? "tests/"}`).join(" and ");
    const e2e = project.settings.e2e;
    return { unit, unitDir, e2e, e2eDir: `${prefix("frontend")}${E2E_DIRS[e2e] ?? "e2e/"}` };
  }

  async runUnit(request: UnitTestRequest): Promise<TestReport[]> {
    const { project, checkout, repo, area } = request;
    const parts: Part[] = area === "shared" ? ["backend", "frontend"] : [area];
    const reports: TestReport[] = [];
    for (const part of parts) {
      if (locatePart(project.shape, part).repo !== repo) continue;
      const framework = this.unitFramework(project, part);
      if (framework === "none") continue;
      const dir = this.partDir(project, part, checkout);
      if (!existsSync(dir)) continue;
      const runner = this.runners[framework];
      await runner.scaffold(dir);
      const report = await runner.run({ cwd: dir, signal: request.signal, log: request.log });
      reports.push(this.relabel(report, project, dir));
    }
    return reports;
  }

  async runE2E(request: E2ETestRequest): Promise<TestReport[]> {
    const { project } = request;
    const framework = project.settings.e2e;
    if (framework === "none") return [];
    const frontendDir = this.partDir(project, "frontend");
    if (!existsSync(frontendDir)) return [];
    const runner = this.runners[framework];
    const scaffolded = await runner.scaffold(frontendDir);
    if (scaffolded.filesWritten.length) await this.commitScaffold(project, "frontend", scaffolded.filesWritten, framework);

    let app: RunningApp | undefined;
    try {
      app = await this.startApp(project, request);
    } catch (err) {
      return [{ ...emptyReport(framework, "e2e", frontendDir), error: `Could not start the app for E2E: ${(err as Error).message}` }].map((r) => this.relabel(r, project, frontendDir));
    }
    try {
      const report = await runner.run({ cwd: frontendDir, baseUrl: app.frontendUrl, signal: request.signal, log: request.log });
      return [this.relabel(report, project, frontendDir)];
    } finally {
      await app.stop();
    }
  }

  /** Write config/dependency stubs for the project's chosen frameworks and commit them. */
  async scaffold(project: Project, layers: ("unit" | "e2e")[] = ["unit", "e2e"]): Promise<string[]> {
    const written: string[] = [];
    const jobs: { part: Part; framework: TestFramework }[] = [];
    if (layers.includes("unit")) {
      for (const part of ["backend", "frontend"] as const) {
        const fw = this.unitFramework(project, part);
        if (fw !== "none") jobs.push({ part, framework: fw });
      }
    }
    if (layers.includes("e2e") && project.settings.e2e !== "none") jobs.push({ part: "frontend", framework: project.settings.e2e });
    for (const { part, framework } of jobs) {
      const dir = this.partDir(project, part);
      if (!existsSync(dir)) continue;
      const res = await this.runners[framework].scaffold(dir);
      if (!res.filesWritten.length) continue;
      await this.commitScaffold(project, part, res.filesWritten, framework);
      const { repo, dirInRepo } = locatePart(project.shape, part);
      written.push(...res.filesWritten.map((f) => path.join(repo, dirInRepo, f)));
    }
    return written;
  }

  private async commitScaffold(project: Project, part: Part, files: string[], framework: string): Promise<void> {
    const { repo, dirInRepo } = locatePart(project.shape, part);
    await new GitRepo(path.join(project.path, repo)).commitAll(`chore: scaffold ${framework} (AppForge)`, files.map((f) => path.join(dirInRepo, f)));
  }

  /** A GitHub Actions workflow per repo that runs the same commands as AppForge. */
  async writeCiWorkflow(project: Project): Promise<string[]> {
    const written: string[] = [];
    for (const ref of project.repos) {
      const jobs: string[] = [];
      for (const part of ["backend", "frontend"] as const) {
        const { repo, dirInRepo } = locatePart(project.shape, part);
        if (repo !== ref.path) continue;
        const fw = this.unitFramework(project, part);
        if (fw !== "none") jobs.push(ciJob(`${part}-unit`, dirInRepo, fw, this.runners[fw].command({}).file, this.runners[fw].command({}).args));
        if (part === "frontend" && project.settings.e2e !== "none") {
          const cmd = this.runners[project.settings.e2e].command({});
          jobs.push(ciJob("e2e", dirInRepo, project.settings.e2e, cmd.file, cmd.args, getStack(project.stackId), project.shape));
        }
      }
      if (!jobs.length) continue;
      const file = path.join(project.path, ref.path, ".github/workflows/appforge-ci.yml");
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, `# Generated by AppForge: runs the same tests AppForge runs locally.\nname: AppForge CI\non: [push, pull_request]\njobs:\n${jobs.join("\n")}`);
      await new GitRepo(path.join(project.path, ref.path)).commitAll("ci: add AppForge test workflow", [".github/workflows/appforge-ci.yml"]);
      written.push(path.join(ref.path, ".github/workflows/appforge-ci.yml"));
    }
    return written;
  }

  private relabel(report: TestReport, project: Project, dir: string): TestReport {
    return { ...report, cwd: path.relative(project.path, dir) || "." };
  }

  // ───────── dev servers for E2E ─────────

  private async startApp(project: Project, request: E2ETestRequest): Promise<RunningApp> {
    const stack = getStack(project.stackId);
    const log = request.log;
    const started: { stop(): Promise<void> }[] = [];
    const stop = async () => {
      await Promise.all(started.map((s) => s.stop()));
    };
    try {
      const backendPort = await findFreePort();
      const backendUrl = `http://127.0.0.1:${backendPort}`;
      const backendDir = this.partDir(project, "backend");
      if (existsSync(backendDir)) {
        started.push(await this.startServer("backend", stack.backend, backendDir, backendPort, backendUrl, request));
      }
      const frontendPort = await findFreePort();
      const frontendUrl = `http://127.0.0.1:${frontendPort}`;
      started.push(await this.startServer("frontend", stack.frontend, this.partDir(project, "frontend"), frontendPort, backendUrl, request));
      log(`App running: frontend ${frontendUrl}, backend ${backendUrl}`);
      return { frontendUrl, backendUrl, stop };
    } catch (err) {
      await stop();
      throw err;
    }
  }

  private async startServer(name: string, part: StackPart, dir: string, port: number, backendUrl: string, request: E2ETestRequest): Promise<{ stop(): Promise<void> }> {
    const opts = { log: request.log, signal: request.signal };
    let file = part.dev.file;
    if (part.language === "python") {
      await ensurePythonVenv(dir, this.processes, [], opts);
      if (file.startsWith("python")) file = venvPython(dir);
    } else if (part.language === "typescript") {
      await ensureNodeDeps(dir, this.processes, opts);
    }
    const fill = (v: string) => v.replaceAll("{port}", String(port)).replaceAll("{backendUrl}", backendUrl);
    const args = part.dev.args.map(fill);
    const env = Object.fromEntries(Object.entries(part.dev.env).map(([k, v]) => [k, fill(v)]));
    request.log(`Starting ${name}: ${file} ${args.join(" ")}`);
    let output = "";
    const child = this.processes.spawn(file, args, { cwd: dir, env, signal: request.signal, onOutput: (c) => (output = tail(output + c, 4_000)) });
    let exited = false;
    void child.then(() => (exited = true));
    const url = `http://127.0.0.1:${port}${part.dev.readyPath}`;
    const ready = await waitForHttp(url, 180_000, request.signal);
    if (!ready || exited) {
      await this.processes.stopAndWait(child);
      throw new Error(`${name} did not answer on ${url}.\n${output}`);
    }
    return { stop: () => this.processes.stopAndWait(child) };
  }
}

interface RunningApp {
  frontendUrl: string;
  backendUrl: string;
  stop(): Promise<void>;
}

function ciJob(name: string, dir: string, framework: string, file: string, args: string[], stack?: ReturnType<typeof getStack>, shape?: Project["shape"]): string {
  const workdir = dir === "." ? "." : dir;
  const setup =
    framework === "pytest"
      ? `      - uses: actions/setup-python@v5\n        with: { python-version: "3.12" }\n      - run: python -m pip install -r requirements.txt pytest\n        working-directory: ${workdir}\n`
      : framework === "xunit"
        ? `      - uses: actions/setup-dotnet@v4\n        with: { dotnet-version: "8.0.x" }\n`
        : `      - uses: actions/setup-node@v4\n        with: { node-version: 22 }\n      - run: npm install\n        working-directory: ${workdir}\n`;
  const browsers = framework === "playwright" ? `      - run: npx playwright install --with-deps chromium\n        working-directory: ${workdir}\n` : "";
  const runFile = framework === "pytest" ? "python" : file;
  let serve = "";
  if (stack && shape === "monorepo") {
    // Start the app the same way AppForge does before E2E.
    const backendCmd = [stack.backend.dev.file, ...stack.backend.dev.args].join(" ").replaceAll("{port}", "3000");
    const frontendCmd = [stack.frontend.dev.file, ...stack.frontend.dev.args].join(" ").replaceAll("{port}", "5173");
    serve = `      - run: npm install\n        working-directory: backend\n      - run: (${backendCmd} &) && sleep 5\n        working-directory: backend\n        env: { PORT: "3000" }\n      - run: (${frontendCmd} &) && sleep 5\n        working-directory: frontend\n        env: { API_URL: "http://127.0.0.1:3000" }\n`;
  }
  return `  ${name}:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v4\n${setup}${browsers}${serve}      - run: ${[runFile, ...args.map((a) => (/[\s[\]*,]/.test(a) ? JSON.stringify(a) : a))].join(" ")}\n        working-directory: ${workdir}\n${stack ? `        env: { BASE_URL: "http://127.0.0.1:5173" }\n` : ""}`;
}
