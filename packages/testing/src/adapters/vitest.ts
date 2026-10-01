import type { TestCaseResult, TestCommand, TestRunOptions } from "@appforge/core";
import { BaseRunner, ensureNodeDeps, ensurePackageJson, REPORT_DIR } from "../base.ts";
import { parseJestJson } from "../parsers.ts";

export class VitestRunner extends BaseRunner {
  readonly id = "vitest" as const;
  readonly layer = "unit" as const;
  readonly label = "Vitest";

  async scaffold(dir: string) {
    const written: string[] = [];
    await ensurePackageJson(dir, { vitest: "^5.0.3" }, { test: "vitest run" }, written);
    return { filesWritten: written, installCommand: "npm install" };
  }

  command(options: Pick<TestRunOptions, "filter">): TestCommand {
    const reportPath = `${REPORT_DIR}/vitest.json`;
    return {
      file: "npx",
      args: [
        "vitest",
        "run",
        "--reporter=json",
        `--outputFile=${reportPath}`,
        // E2E specs belong to Playwright/Cypress, not the unit runner.
        "--exclude=**/node_modules/**",
        "--exclude=**/e2e/**",
        "--exclude=**/cypress/**",
        ...(options.filter ? [options.filter] : []),
      ],
      reportPath,
    };
  }

  protected override prepare(options: TestRunOptions) {
    return ensureNodeDeps(options.cwd, this.processes, options);
  }

  protected parseCases(docs: string[]): TestCaseResult[] {
    return parseJestJson(docs);
  }
}
