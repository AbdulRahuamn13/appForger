import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RawTestOutput, TestCaseResult, TestCommand, TestFramework, TestLayer, TestReport, TestRunnerAdapter, TestRunOptions } from "@appforge/core";
import { tail } from "@appforge/core";
import type { ProcessRegistry } from "@appforge/workspace";
import { emptyReport, tally } from "./parsers.ts";

export const REPORT_DIR = ".appforge/reports";

/**
 * Shared run logic: prepare dependencies, run the framework's headless
 * command, read its machine-readable report, and parse it into a TestReport.
 */
export abstract class BaseRunner implements TestRunnerAdapter {
  abstract readonly id: TestFramework;
  abstract readonly layer: TestLayer;
  abstract readonly label: string;

  constructor(protected readonly processes: ProcessRegistry) {}

  abstract scaffold(dir: string): Promise<{ filesWritten: string[]; installCommand?: string }>;
  abstract command(options: Pick<TestRunOptions, "filter" | "baseUrl">): TestCommand;
  protected abstract parseCases(docs: string[]): TestCaseResult[];

  /** Install dependencies etc. before running. */
  protected async prepare(_options: TestRunOptions): Promise<void> {}

  /** Lets adapters adjust the command once they can look at the folder. */
  protected async resolveCommand(options: TestRunOptions): Promise<TestCommand> {
    return this.command(options);
  }

  /** Return true to retry once (e.g. after installing missing browsers). */
  protected async recover(_raw: RawTestOutput, _options: TestRunOptions): Promise<boolean> {
    return false;
  }

  async run(options: TestRunOptions): Promise<TestReport> {
    const startedAt = new Date().toISOString();
    try {
      await this.prepare(options);
    } catch (err) {
      return { ...emptyReport(this.id, this.layer, options.cwd), startedAt, error: `Could not prepare ${this.label}: ${(err as Error).message}` };
    }
    let raw = await this.exec(options);
    if (await this.recover(raw, options)) raw = await this.exec(options);
    const report = this.parseResults(raw, options.cwd);
    report.startedAt = startedAt;
    return report;
  }

  private async exec(options: TestRunOptions): Promise<RawTestOutput> {
    const cmd = await this.resolveCommand(options);
    const reportAbs = path.join(options.cwd, cmd.reportPath);
    await rm(reportAbs, { recursive: true, force: true });
    await mkdir(path.extname(cmd.reportPath) ? path.dirname(reportAbs) : reportAbs, { recursive: true });
    options.log?.(`$ ${[cmd.file, ...cmd.args].join(" ")}  (in ${options.cwd})`);
    const result = await this.processes.run(cmd.file, cmd.args, {
      cwd: options.cwd,
      env: { ...cmd.env, ...options.env, ...(options.baseUrl ? { BASE_URL: options.baseUrl } : {}) },
      timeoutMs: options.timeoutMs ?? 15 * 60_000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr, durationMs: result.durationMs, reportFiles: await readReports(reportAbs) };
  }

  parseResults(raw: RawTestOutput, cwd: string): TestReport {
    const report = emptyReport(this.id, this.layer, cwd);
    report.durationMs = raw.durationMs;
    const output = `${raw.stdout}\n${raw.stderr}`.trim();
    report.outputTail = tail(output, 4_000);
    let cases: TestCaseResult[] = [];
    try {
      cases = this.parseCases(raw.reportFiles);
    } catch (err) {
      report.error = `Could not parse the ${this.label} report: ${(err as Error).message}`;
    }
    Object.assign(report, tally(cases), { cases });
    if (!raw.reportFiles.length && !report.error) {
      report.error = raw.exitCode === 0 ? `${this.label} produced no report` : `${this.label} exited with code ${raw.exitCode ?? "?"} without a report`;
    } else if (raw.exitCode !== 0 && report.failed === 0 && !report.error) {
      report.error = `${this.label} exited with code ${raw.exitCode ?? "?"}`;
    }
    if (report.total === 0 && !report.error) report.error = "No tests were found";
    return report;
  }
}

async function readReports(target: string): Promise<string[]> {
  try {
    const st = await stat(target);
    if (st.isFile()) return [await readFile(target, "utf8")];
    const files = (await readdir(target)).filter((f) => /\.(json|xml|trx)$/i.test(f)).sort();
    return Promise.all(files.map((f) => readFile(path.join(target, f), "utf8")));
  } catch {
    return [];
  }
}

// ───────── scaffolding helpers ─────────

export async function writeIfMissing(dir: string, rel: string, content: string, written: string[]): Promise<void> {
  const target = path.join(dir, rel);
  if (existsSync(target)) return;
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
  written.push(rel);
}

export function anyExists(dir: string, names: string[]): boolean {
  return names.some((n) => existsSync(path.join(dir, n)));
}

interface PackageJson {
  name?: string;
  private?: boolean;
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
  [key: string]: unknown;
}

/** Add dev dependencies/scripts to package.json without touching existing entries. */
export async function ensurePackageJson(
  dir: string,
  devDependencies: Record<string, string>,
  scripts: Record<string, string>,
  written: string[],
): Promise<void> {
  const file = path.join(dir, "package.json");
  let pkg: PackageJson = { name: path.basename(dir), private: true };
  if (existsSync(file)) pkg = JSON.parse(await readFile(file, "utf8")) as PackageJson;
  let changed = !existsSync(file);
  pkg.devDependencies ??= {};
  for (const [name, version] of Object.entries(devDependencies)) {
    if (!pkg.devDependencies[name] && !pkg.dependencies?.[name]) {
      pkg.devDependencies[name] = version;
      changed = true;
    }
  }
  pkg.scripts ??= {};
  for (const [name, script] of Object.entries(scripts)) {
    if (!pkg.scripts[name]) {
      pkg.scripts[name] = script;
      changed = true;
    }
  }
  if (changed) {
    await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
    written.push("package.json");
  }
}

// ───────── dependency setup ─────────

/** `npm install` (or pnpm/yarn by lockfile) when node_modules is missing. */
export async function ensureNodeDeps(dir: string, processes: ProcessRegistry, options: Pick<TestRunOptions, "log" | "signal">): Promise<void> {
  if (!existsSync(path.join(dir, "package.json")) || existsSync(path.join(dir, "node_modules"))) return;
  const [file, args] = existsSync(path.join(dir, "pnpm-lock.yaml"))
    ? ["pnpm", ["install"]]
    : existsSync(path.join(dir, "yarn.lock"))
      ? ["yarn", ["install"]]
      : ["npm", ["install", "--no-audit", "--no-fund"]];
  options.log?.(`Installing dependencies in ${dir} (${file} ${args.join(" ")})`);
  const res = await processes.run(file, args, {
    cwd: dir,
    timeoutMs: 15 * 60_000,
    // Browser binaries are fetched on demand by the E2E runners that need them.
    env: { CYPRESS_INSTALL_BINARY: "0", PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: "1" },
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (res.exitCode !== 0) throw new Error(`${file} install failed (exit ${res.exitCode}): ${tail(res.all, 1_500)}`);
}

export function venvPython(dir: string): string {
  return process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python");
}

/** Create .venv and install requirements.txt (+ extras) once per requirements change. */
export async function ensurePythonVenv(dir: string, processes: ProcessRegistry, extras: string[], options: Pick<TestRunOptions, "log" | "signal">): Promise<string> {
  const python = venvPython(dir);
  const reqFile = path.join(dir, "requirements.txt");
  const requirements = existsSync(reqFile) ? await readFile(reqFile, "utf8") : "";
  const stamp = path.join(dir, ".venv", ".appforge-requirements");
  const wanted = `${requirements}\n${extras.join("\n")}`;
  const run = (file: string, args: string[]) =>
    processes.run(file, args, { cwd: dir, timeoutMs: 15 * 60_000, ...(options.signal ? { signal: options.signal } : {}) });
  if (!existsSync(python)) {
    options.log?.(`Creating a Python virtualenv in ${dir}/.venv`);
    const res = await run(process.platform === "win32" ? "python" : "python3", ["-m", "venv", ".venv"]);
    if (res.exitCode !== 0) throw new Error(`python -m venv failed: ${tail(res.all, 1_000)}`);
  }
  const current = existsSync(stamp) ? await readFile(stamp, "utf8") : undefined;
  if (current !== wanted) {
    options.log?.(`Installing Python packages in ${dir}/.venv`);
    const args = ["-m", "pip", "install", "--disable-pip-version-check", "-q", ...(requirements ? ["-r", "requirements.txt"] : []), ...extras];
    const res = await run(python, args);
    if (res.exitCode !== 0) throw new Error(`pip install failed: ${tail(res.all, 1_500)}`);
    await writeFile(stamp, wanted);
  }
  return python;
}
