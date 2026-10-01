import picomatch from "picomatch";
import type { AccessPolicy } from "@appforge/core";
import type { GitRepo } from "./git.ts";

export function matchesAny(file: string, patterns: string[]): boolean {
  if (!patterns.length) return false;
  return picomatch(patterns, { dot: true })(file);
}

/** Can a session with this policy write `file` (repo-relative)? */
export function canWrite(policy: AccessPolicy, file: string): boolean {
  if (policy.mode === "full") return true;
  if (policy.mode === "read-only") return false;
  return matchesAny(file, policy.writable ?? []);
}

export interface PolicyViolation {
  path: string;
  reason: string;
}

/**
 * After an agent turn, check what it actually changed against its access
 * policy and (optional) swarm file ownership, and revert anything outside it.
 * This is the backstop for adapters whose vendor sandbox can't express
 * per-path rules (e.g. Codex workspace-write).
 */
export async function enforceWritePolicy(
  repo: GitRepo,
  policy: AccessPolicy,
  ownership: string[] = [],
  alwaysAllowed: string[] = [],
): Promise<PolicyViolation[]> {
  const changed = await repo.changedFiles();
  const violations: PolicyViolation[] = [];
  for (const file of changed) {
    if (matchesAny(file.path, alwaysAllowed)) continue;
    if (!canWrite(policy, file.path)) {
      violations.push({ path: file.path, reason: `role is ${policy.mode === "read-only" ? "read-only" : "limited to " + (policy.writable ?? []).join(", ")}` });
    } else if (ownership.length && !matchesAny(file.path, ownership)) {
      violations.push({ path: file.path, reason: `outside this task's file ownership (${ownership.join(", ")})` });
    }
  }
  if (violations.length) await repo.revertPaths(violations.map((v) => v.path));
  return violations;
}
