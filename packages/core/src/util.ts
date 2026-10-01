import type { ProjectSettings, ReviewIssue, ReviewResult, RoleId } from "./domain.ts";

export function newId(prefix = ""): string {
  const id = globalThis.crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  return prefix ? `${prefix}_${id}` : id;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function slugify(text: string, max = 40): string {
  const slug = text
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)
    .replace(/-+$/g, "");
  return slug || "task";
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}… [${text.length - max} more chars]`;
}

export function tail(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`;
}

export const DEFAULT_ROLE_ASSIGNMENTS: Record<RoleId, { provider: string; model?: string }> = {
  architect: { provider: "claude-code" },
  coder: { provider: "claude-code" },
  // Cross-vendor review catches more; switch to "claude-code" if Codex isn't set up.
  reviewer: { provider: "codex-cli" },
  "test-author": { provider: "claude-code" },
  integrator: { provider: "claude-code" },
};

export function defaultProjectSettings(overrides: Partial<ProjectSettings> = {}): ProjectSettings {
  return {
    e2e: "playwright",
    unitBackend: "vitest",
    unitFrontend: "vitest",
    roles: { ...DEFAULT_ROLE_ASSIGNMENTS },
    concurrency: 3,
    maxFixLoops: 3,
    requireApproval: true,
    ...overrides,
  };
}

/**
 * Pull the first JSON value out of agent prose: a ```json fence wins, then the
 * first balanced {...} or [...] block. Returns undefined when nothing parses.
 */
export function extractJson(text: string): unknown {
  const fences = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)];
  for (const fence of fences) {
    const body = fence[1];
    if (body === undefined) continue;
    try {
      return JSON.parse(body.trim());
    } catch {
      // try the next candidate
    }
  }
  for (let start = 0; start < text.length; start++) {
    const ch = text[start];
    if (ch !== "{" && ch !== "[") continue;
    const end = findBalancedEnd(text, start);
    if (end === -1) continue;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      // keep scanning
    }
  }
  return undefined;
}

function findBalancedEnd(text: string, start: number): number {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") {
      if (stack.pop() !== ch) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

const SEVERITIES = new Set(["blocker", "major", "minor", "nit"]);

/** Parse a Reviewer reply into {verdict, issues[]}; malformed replies become a blocker. */
export function parseReview(text: string): ReviewResult {
  const json = extractJson(text);
  if (!isRecord(json)) {
    return {
      verdict: "request-changes",
      issues: [{ severity: "blocker", message: "Reviewer did not return the required JSON verdict." }],
      summary: truncate(text, 2000),
    };
  }
  const rawIssues = Array.isArray(json.issues) ? json.issues : [];
  const issues: ReviewIssue[] = rawIssues.filter(isRecord).map((issue) => {
    const severity = typeof issue.severity === "string" && SEVERITIES.has(issue.severity) ? issue.severity : "major";
    const out: ReviewIssue = {
      severity: severity as ReviewIssue["severity"],
      message: typeof issue.message === "string" ? issue.message : JSON.stringify(issue),
    };
    if (typeof issue.file === "string") out.file = issue.file;
    if (typeof issue.line === "number") out.line = issue.line;
    return out;
  });
  const verdictRaw = typeof json.verdict === "string" ? json.verdict.toLowerCase() : "";
  let verdict: ReviewResult["verdict"] =
    verdictRaw === "approve" || verdictRaw === "approved" ? "approve" : "request-changes";
  // A reviewer cannot approve while listing blockers.
  if (issues.some((i) => i.severity === "blocker")) verdict = "request-changes";
  const result: ReviewResult = { verdict, issues };
  if (typeof json.summary === "string") result.summary = json.summary;
  return result;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isRateLimitMessage(message: string): boolean {
  return /rate.?limit|usage limit|429|quota|too many requests|limit reached|overloaded/i.test(message);
}
