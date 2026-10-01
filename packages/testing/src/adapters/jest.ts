import type { TestCaseResult, TestCommand, TestRunOptions } from "@appforge/core";
import { anyExists, BaseRunner, ensureNodeDeps, ensurePackageJson, REPORT_DIR, writeIfMissing } from "../base.ts";
import { parseJestJson } from "../parsers.ts";

export class JestRunner extends BaseRunner {
  readonly id = "jest" as const;
  readonly layer = "unit" as const;
  readonly label = "Jest";

  async scaffold(dir: string) {
    const written: string[] = [];
    await ensurePackageJson(dir, { jest: "^30.5.2", "ts-jest": "^29.4.14", "@types/jest": "^30.0.0", typescript: "~6.0.3" }, { test: "jest" }, written);
    if (!anyExists(dir, ["jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts"])) {
      await writeIfMissing(
        dir,
        "jest.config.cjs",
        `/** @type {import('jest').Config} */\nmodule.exports = {\n  preset: "ts-jest",\n  testEnvironment: "node",\n  testPathIgnorePatterns: ["/node_modules/", "/e2e/", "/cypress/"],\n};\n`,
        written,
      );
    }
    return { filesWritten: written, installCommand: "npm install" };
  }

  command(options: Pick<TestRunOptions, "filter">): TestCommand {
    const reportPath = `${REPORT_DIR}/jest.json`;
    return {
      file: "npx",
      args: ["jest", "--ci", "--json", `--outputFile=${reportPath}`, "--testPathIgnorePatterns=/node_modules/", "--testPathIgnorePatterns=/e2e/", "--testPathIgnorePatterns=/cypress/", ...(options.filter ? [options.filter] : [])],
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
