import type { AccessPolicy, ProjectSettings, ProjectShape, ReviewResult, RoleId, Task, TestReport } from "@appforge/core";
import { truncate } from "@appforge/core";
import type { StackTemplate } from "./stacks.ts";

export interface PromptContext {
  projectName: string;
  shape: ProjectShape;
  stack: StackTemplate;
  settings: Pick<ProjectSettings, "e2e" | "unitBackend" | "unitFrontend">;
}

/** Globs a Test author may write (relative to the repo it works in). */
export const TEST_GLOBS = [
  "**/test/**",
  "**/tests/**",
  "**/__tests__/**",
  "**/*.test.*",
  "**/*.spec.*",
  "**/e2e/**",
  "**/cypress/**",
  "**/playwright.config.*",
  "**/cypress.config.*",
  "**/vitest.config.*",
  "**/jest.config.*",
  "**/*.Tests/**",
  "**/conftest.py",
  "**/test_*.py",
  "**/*_test.py",
  "**/pytest.ini",
];

export const DOC_GLOBS = ["docs/**", "**/openapi.yaml", "**/openapi.json", "README.md"];

/** Files any role may touch as a side effect of running tooling. */
export const TOOLING_SIDE_EFFECTS = ["**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock", "**/*.tsbuildinfo"];

export function roleAccess(role: RoleId): AccessPolicy {
  switch (role) {
    case "architect":
      return { mode: "scoped", writable: DOC_GLOBS, shell: true };
    case "coder":
      return { mode: "full", shell: true };
    case "reviewer":
      return { mode: "read-only", shell: true };
    case "test-author":
      return { mode: "scoped", writable: TEST_GLOBS, shell: true };
    case "integrator":
      return { mode: "full", shell: true };
  }
}

const SHARED_RULES = [
  "You are one agent in AppForge, a local multi-agent app builder. Other agents and a human reviewer work on the same project.",
  "Work only inside the current working directory. Never read or print credentials, tokens, or files under ~/.claude, ~/.codex or similar.",
  "Do not run git commands that change history or branches (commit, checkout, push, merge, reset): AppForge commits and merges for you.",
  "Shell commands go through an allow-list; if one is blocked, use a different approach instead of retrying it.",
  "Keep changes focused on your assignment. Prefer small, readable code that matches the project's conventions.",
].join("\n- ");

function projectBlock(ctx: PromptContext): string {
  const layout =
    ctx.shape === "monorepo"
      ? "Monorepo: backend/ and frontend/ live in one git repository, with shared docs in docs/."
      : "Two separate git repositories: backend/ and frontend/. Shared docs (spec, OpenAPI contract) are copied into each repo's docs/ folder.";
  return [
    `Project: ${ctx.projectName}`,
    `Stack: ${ctx.stack.label} — ${ctx.stack.description}`,
    layout,
    ctx.stack.backend.conventions,
    ctx.stack.frontend.conventions,
    `Unit tests: backend uses ${ctx.settings.unitBackend}, frontend uses ${ctx.settings.unitFrontend}. E2E: ${ctx.settings.e2e}.`,
  ].join("\n");
}

const ROLE_INTROS: Record<RoleId, string> = {
  architect:
    "You are the Architect. Turn the brief into a precise spec, an OpenAPI contract, and a task list other agents can build in parallel. You write documentation only — never application code.",
  coder:
    "You are a Coder. Implement exactly one task on your own branch. Follow the spec and the OpenAPI contract in docs/. Make the code run, and run the relevant build/tests yourself before finishing.",
  reviewer:
    "You are the Reviewer. You are read-only. Review a diff for bugs, security problems, drift from the OpenAPI contract/spec, and missing error handling. Be specific and actionable; do not nitpick style the linter would catch.",
  "test-author":
    "You are the Test author. Write unit tests and E2E specs in the project's chosen frameworks. Only create or edit test files and test configuration — never application code.",
  integrator:
    "You are the Integrator. You resolve merge conflicts so both sides' intent survives, and you write the final integration report.",
};

export function systemPrompt(role: RoleId, ctx: PromptContext): string {
  return `${ROLE_INTROS[role]}\n\n## Project\n${projectBlock(ctx)}\n\n## Rules\n- ${SHARED_RULES}`;
}

export const ARCHITECT_OUTPUT_SCHEMA = `{
  "summary": "one paragraph",
  "tasks": [
    {
      "key": "short-kebab-id",
      "title": "Imperative title",
      "description": "What to build, acceptance criteria, endpoints/components involved",
      "area": "backend" | "frontend" | "shared",
      "dependsOn": ["keys of tasks that must merge first"],
      "files": ["globs this task owns, relative to the project folder, e.g. backend/src/routes/todos/**"]
    }
  ]
}`;

export function architectPrompt(brief: string, opts: { maxTasks: number; parallel: boolean }): string {
  return [
    "## Brief",
    brief,
    "",
    "## Your job",
    "1. Read what already exists in the project folder.",
    "2. Write docs/SPEC.md: goals, data model, API endpoints, UI screens, and acceptance criteria.",
    "3. Write docs/openapi.yaml: the OpenAPI 3.1 contract for every backend endpoint. Frontend and backend must both follow it.",
    `4. Split the work into at most ${opts.maxTasks} tasks. ${
      opts.parallel
        ? "Tasks will run in parallel in separate git worktrees, so give every task non-overlapping file ownership (files globs) and only add dependsOn where one task truly needs another merged first."
        : "Tasks run one at a time in the order you list them."
    } Each task must be completable and testable on its own. Keep backend and frontend work in separate tasks.`,
    "",
    "Finish with ONLY this JSON in a ```json fenced block (no other JSON in your reply):",
    "```",
    ARCHITECT_OUTPUT_SCHEMA,
    "```",
  ].join("\n");
}

export interface CoderFeedback {
  review?: ReviewResult;
  testReports?: TestReport[];
  humanComment?: string;
  policyViolations?: string[];
}

export function coderPrompt(task: Pick<Task, "title" | "description" | "files" | "area">, feedback?: CoderFeedback): string {
  const parts = [
    `## Task: ${task.title}`,
    task.description,
    "",
    `Area: ${task.area}.`,
    task.files.length ? `You own these paths (stay inside them): ${task.files.join(", ")}` : "",
    "Read docs/SPEC.md and docs/openapi.yaml first if they exist.",
    "When done, reply with a short summary of what you changed and how you verified it. Do not commit.",
  ];
  if (feedback) parts.push("", "## Fix the following before finishing", formatFeedback(feedback));
  return parts.filter((p) => p !== "").join("\n");
}

export function formatFeedback(feedback: CoderFeedback): string {
  const out: string[] = [];
  if (feedback.humanComment) out.push(`Human reviewer: ${feedback.humanComment}`);
  if (feedback.review && feedback.review.verdict !== "approve") {
    out.push("Reviewer requested changes:");
    for (const issue of feedback.review.issues) {
      const where = issue.file ? ` (${issue.file}${issue.line ? `:${issue.line}` : ""})` : "";
      out.push(`- [${issue.severity}]${where} ${issue.message}`);
    }
  }
  for (const report of feedback.testReports ?? []) {
    if (report.error) out.push(`${report.framework} (${report.cwd}) could not run: ${report.error}\n${report.outputTail ?? ""}`);
    const failures = report.cases.filter((c) => c.status === "failed");
    if (failures.length) {
      out.push(`${report.framework} ${report.layer} tests failing in ${report.cwd}:`);
      for (const f of failures.slice(0, 20)) {
        out.push(`- ${f.suite ? `${f.suite} › ` : ""}${f.name}${f.file ? ` (${f.file})` : ""}: ${truncate(f.error?.message ?? "failed", 800)}`);
        if (f.attachments?.length) out.push(`  attachments: ${f.attachments.join(", ")}`);
      }
    }
  }
  if (feedback.policyViolations?.length) {
    out.push("These changes were reverted because they were outside your allowed paths:", ...feedback.policyViolations.map((v) => `- ${v}`));
  }
  return out.join("\n");
}

export const REVIEW_OUTPUT_SCHEMA = `{"verdict": "approve" | "request-changes", "summary": "...", "issues": [{"severity": "blocker" | "major" | "minor" | "nit", "file": "path", "line": 12, "message": "..."}]}`;

export function reviewerPrompt(task: Pick<Task, "title" | "description">, diff: string, maxDiffChars = 120_000): string {
  return [
    `## Review the diff for task: ${task.title}`,
    task.description,
    "",
    "Check against docs/SPEC.md and docs/openapi.yaml (read them). You may read any file for context, but change nothing.",
    "Approve only if there are no blocker or major issues.",
    "",
    "```diff",
    truncate(diff, maxDiffChars),
    "```",
    "",
    `Reply with ONLY this JSON in a \`\`\`json fenced block:\n${REVIEW_OUTPUT_SCHEMA}`,
  ].join("\n");
}

export function testAuthorPrompt(
  task: Pick<Task, "title" | "description" | "area">,
  frameworks: { unit: string; unitDir: string; e2e: string; e2eDir: string },
): string {
  const lines = [
    `## Write tests for task: ${task.title}`,
    task.description,
    "",
    `Unit tests: use ${frameworks.unit} in ${frameworks.unitDir}. Cover the behaviour this task added, including error cases.`,
  ];
  if (frameworks.e2e !== "none" && task.area !== "backend") {
    lines.push(
      `E2E: use ${frameworks.e2e}; put specs in ${frameworks.e2eDir}. The app's URL comes from the BASE_URL environment variable (AppForge starts the servers). Prefer role/label/data-testid selectors.`,
    );
  }
  lines.push(
    "Hard constraints: only create or edit test files and test config. If application code looks wrong, describe it in your reply instead of changing it.",
    "Run the unit tests you wrote. Reply with a summary of the tests you added.",
  );
  return lines.join("\n");
}

export function conflictPrompt(branch: string, conflicts: string[], taskTitle: string): string {
  return [
    `## Resolve merge conflicts from ${branch} (${taskTitle})`,
    "These files contain git conflict markers (<<<<<<< ======= >>>>>>>):",
    ...conflicts.map((c) => `- ${c}`),
    "",
    "Edit each file so both sides' intent survives, remove every conflict marker, and make sure the code still builds. Do not run git commands. Reply with a summary of how you resolved each file.",
  ].join("\n");
}

export function integrationReportPrompt(summary: string): string {
  return [
    "## Write the integration report",
    "All approved tasks have been merged. Here is what happened:",
    summary,
    "",
    "Write docs/REPORT.md: what was built, how to run it (install + dev commands), test results, and known gaps. Then reply with a 3-5 sentence summary.",
  ].join("\n");
}

export function singlePrompt(brief: string): string {
  return [
    "## Request",
    brief,
    "",
    "You are working alone on a dedicated branch. Make the change end to end, run what you can to verify it, and reply with a summary. Do not commit.",
  ].join("\n");
}

export function nativeTeamPrompt(brief: string, teammates: number): string {
  return [
    "## Brief",
    brief,
    "",
    `Create an agent team to build this. Spawn up to ${teammates} teammates (for example backend, frontend, and tests), give each clear file ownership, and coordinate through the shared task list.`,
    "Start by writing docs/SPEC.md and docs/openapi.yaml yourself so every teammate builds against the same contract.",
    "Teammates must not edit the same files. When everyone is done, run the tests, then reply with a summary. Do not commit; AppForge reviews and merges the branch.",
  ].join("\n");
}
