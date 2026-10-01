import type { RawTestOutput, TestCaseResult, TestCommand, TestRunOptions } from "@appforge/core";
import { anyExists, BaseRunner, ensureNodeDeps, ensurePackageJson, REPORT_DIR, writeIfMissing } from "../base.ts";
import { parsePlaywrightJson } from "../parsers.ts";

export class PlaywrightRunner extends BaseRunner {
  readonly id = "playwright" as const;
  readonly layer = "e2e" as const;
  readonly label = "Playwright";

  async scaffold(dir: string) {
    const written: string[] = [];
    await ensurePackageJson(dir, { "@playwright/test": "^1.56.1" }, { "test:e2e": "playwright test" }, written);
    if (!anyExists(dir, ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"])) {
      await writeIfMissing(
        dir,
        "playwright.config.ts",
        `import { defineConfig, devices } from "@playwright/test";

// AppForge starts the app and passes its URL in BASE_URL.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.BASE_URL ?? "http://127.0.0.1:5173",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
`,
        written,
      );
    }
    await writeIfMissing(
      dir,
      "e2e/smoke.spec.ts",
      `import { expect, test } from "@playwright/test";

test("the app loads", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator("body")).toBeVisible();
});
`,
      written,
    );
    return { filesWritten: written, installCommand: "npm install && npx playwright install chromium" };
  }

  command(options: Pick<TestRunOptions, "filter" | "baseUrl">): TestCommand {
    const reportPath = `${REPORT_DIR}/playwright.json`;
    return {
      file: "npx",
      args: ["playwright", "test", "--reporter=json", ...(options.filter ? [options.filter] : [])],
      env: { PLAYWRIGHT_JSON_OUTPUT_NAME: reportPath, PLAYWRIGHT_JSON_OUTPUT_FILE: reportPath },
      reportPath,
    };
  }

  protected override prepare(options: TestRunOptions) {
    return ensureNodeDeps(options.cwd, this.processes, options);
  }

  /** First run on a machine: download the browser, then retry once. */
  protected override async recover(raw: RawTestOutput, options: TestRunOptions): Promise<boolean> {
    if (!/Executable doesn't exist|playwright install/i.test(`${raw.stdout}${raw.stderr}`)) return false;
    options.log?.("Installing the Playwright Chromium browser");
    const res = await this.processes.run("npx", ["playwright", "install", "chromium"], { cwd: options.cwd, timeoutMs: 15 * 60_000, ...(options.signal ? { signal: options.signal } : {}) });
    return res.exitCode === 0;
  }

  protected parseCases(docs: string[]): TestCaseResult[] {
    return parsePlaywrightJson(docs);
  }
}
