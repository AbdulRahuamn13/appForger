import type { TestFramework, TestLayer, TestReport } from "./domain.ts";

export interface TestRunOptions {
  /** Absolute directory to run in (a repo root, or a sub-folder of it). */
  cwd: string;
  /** Only run tests whose name/file matches. */
  filter?: string;
  /** Base URL of the running app, for E2E runners. */
  baseUrl?: string;
  /** Extra environment for the runner process. */
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** Raw output of a runner process, before parsing. */
export interface RawTestOutput {
  exitCode: number | undefined;
  stdout: string;
  stderr: string;
  /** Contents of the machine-readable report file, if the runner wrote one. */
  reportFile?: string;
  durationMs: number;
}

/**
 * One adapter per framework. Adding a framework = one new adapter; the
 * orchestrator only sees TestReport.
 */
export interface TestRunnerAdapter {
  readonly id: TestFramework;
  readonly layer: TestLayer;
  readonly label: string;
  /** Write config/dependency stubs so the framework is ready to run. Idempotent. */
  scaffold(dir: string): Promise<{ filesWritten: string[]; installCommand?: string }>;
  /** Shell command the orchestrator runs (also used for the generated CI workflow). */
  command(options: Pick<TestRunOptions, "filter" | "baseUrl">): { file: string; args: string[]; reportPath: string };
  run(options: TestRunOptions): Promise<TestReport>;
  parseResults(raw: RawTestOutput, cwd: string): TestReport;
}
