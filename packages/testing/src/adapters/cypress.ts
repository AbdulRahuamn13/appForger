import type { RawTestOutput, TestCaseResult, TestCommand, TestRunOptions } from "@appforge/core";
import { anyExists, BaseRunner, ensureNodeDeps, ensurePackageJson, REPORT_DIR, writeIfMissing } from "../base.ts";
import { parseJUnit } from "../parsers.ts";

export class CypressRunner extends BaseRunner {
  readonly id = "cypress" as const;
  readonly layer = "e2e" as const;
  readonly label = "Cypress";

  async scaffold(dir: string) {
    const written: string[] = [];
    await ensurePackageJson(dir, { cypress: "^16.1.1" }, { "test:e2e": "cypress run" }, written);
    if (!anyExists(dir, ["cypress.config.ts", "cypress.config.js", "cypress.config.mjs"])) {
      await writeIfMissing(
        dir,
        "cypress.config.ts",
        `import { defineConfig } from "cypress";

// AppForge starts the app and passes its URL in BASE_URL.
export default defineConfig({
  e2e: {
    baseUrl: process.env.BASE_URL ?? "http://127.0.0.1:5173",
    specPattern: "cypress/e2e/**/*.cy.{js,ts}",
    supportFile: false,
    video: false,
  },
});
`,
        written,
      );
    }
    await writeIfMissing(
      dir,
      "cypress/e2e/smoke.cy.ts",
      `describe("app", () => {
  it("loads", () => {
    cy.visit("/");
    cy.get("body").should("be.visible");
  });
});
`,
      written,
    );
    return { filesWritten: written, installCommand: "npm install" };
  }

  command(options: Pick<TestRunOptions, "filter" | "baseUrl">): TestCommand {
    const reportPath = `${REPORT_DIR}/cypress`;
    return {
      file: "npx",
      args: [
        "cypress",
        "run",
        "--reporter",
        "junit",
        "--reporter-options",
        `mochaFile=${reportPath}/results-[hash].xml,toConsole=false`,
        ...(options.baseUrl ? ["--config", `baseUrl=${options.baseUrl}`] : []),
        ...(options.filter ? ["--spec", options.filter] : []),
      ],
      reportPath,
    };
  }

  protected override prepare(options: TestRunOptions) {
    return ensureNodeDeps(options.cwd, this.processes, options);
  }

  /** Dependencies are installed without the Cypress binary; fetch it the first time Cypress runs. */
  protected override async recover(raw: RawTestOutput, options: TestRunOptions): Promise<boolean> {
    if (!/binary (is )?missing|could not find (the )?Cypress|cypress install|CYPRESS_INSTALL_BINARY/i.test(`${raw.stdout}${raw.stderr}`)) return false;
    options.log?.("Installing the Cypress binary");
    const res = await this.processes.run("npx", ["cypress", "install"], { cwd: options.cwd, timeoutMs: 15 * 60_000, ...(options.signal ? { signal: options.signal } : {}) });
    return res.exitCode === 0;
  }

  protected parseCases(docs: string[]): TestCaseResult[] {
    return parseJUnit(docs);
  }
}
