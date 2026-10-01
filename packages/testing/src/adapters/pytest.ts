import { existsSync } from "node:fs";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import type { TestCaseResult, TestCommand, TestRunOptions } from "@appforge/core";
import { BaseRunner, ensurePythonVenv, REPORT_DIR, venvPython, writeIfMissing } from "../base.ts";
import { parseJUnit } from "../parsers.ts";

export class PytestRunner extends BaseRunner {
  readonly id = "pytest" as const;
  readonly layer = "unit" as const;
  readonly label = "pytest";
  private cwd = "";

  async scaffold(dir: string) {
    const written: string[] = [];
    await writeIfMissing(dir, "pytest.ini", "[pytest]\ntestpaths = tests\n", written);
    await writeIfMissing(dir, "tests/__init__.py", "", written);
    const req = path.join(dir, "requirements.txt");
    const current = existsSync(req) ? await readFile(req, "utf8") : "";
    if (!/^pytest\b/m.test(current)) {
      await appendFile(req, `${current && !current.endsWith("\n") ? "\n" : ""}pytest>=8\n`);
      written.push("requirements.txt");
    }
    return { filesWritten: written, installCommand: "python3 -m venv .venv && .venv/bin/pip install -r requirements.txt" };
  }

  command(options: Pick<TestRunOptions, "filter">): TestCommand {
    const reportPath = `${REPORT_DIR}/pytest.xml`;
    const python = this.cwd && existsSync(venvPython(this.cwd)) ? venvPython(this.cwd) : "python3";
    return { file: python, args: ["-m", "pytest", "-q", `--junitxml=${reportPath}`, ...(options.filter ? ["-k", options.filter] : [])], reportPath };
  }

  protected override async prepare(options: TestRunOptions) {
    await ensurePythonVenv(options.cwd, this.processes, ["pytest"], options);
  }

  protected override async resolveCommand(options: TestRunOptions) {
    this.cwd = options.cwd;
    return this.command(options);
  }

  protected parseCases(docs: string[]): TestCaseResult[] {
    return parseJUnit(docs);
  }
}
