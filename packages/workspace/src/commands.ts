import { existsSync } from "node:fs";
import path from "node:path";
import { isWithin } from "./sandbox.ts";

/**
 * Allow-list for shell commands agents want to run. A command line is split
 * into segments (&&, ||, ;, |, &) and every segment must start with an
 * allowed program; sub-commands, path arguments and a few dangerous patterns
 * are checked on top. Anything we cannot parse confidently is rejected.
 */
export interface CommandPolicy {
  /** Allowed programs (first word of each segment). */
  programs: string[];
  /** Per-program sub-commands that are always rejected. */
  deniedSubcommands: Record<string, string[]>;
  /** Patterns rejected anywhere in the command line. */
  deniedPatterns: { pattern: RegExp; reason: string }[];
}

export const DEFAULT_COMMAND_POLICY: CommandPolicy = {
  programs: [
    // JS toolchain
    "node", "npm", "npx", "pnpm", "yarn", "tsc", "tsx", "vite", "vitest", "jest", "eslint", "prettier", "playwright", "cypress",
    // Python
    "python", "python3", "pip", "pip3", "pytest", "uvicorn", "uv", "ruff",
    // .NET
    "dotnet",
    // VCS (sub-commands filtered below)
    "git",
    // Read-only / file utilities
    "ls", "cat", "head", "tail", "wc", "grep", "rg", "find", "echo", "printf", "pwd", "mkdir", "touch", "cp", "mv", "rm",
    "sed", "awk", "diff", "sort", "uniq", "which", "test", "true", "false", "cd", "tree", "jq", "sleep",
  ],
  deniedSubcommands: {
    git: [
      "push", "pull", "fetch", "remote", "config", "worktree", "checkout", "switch", "rebase", "reset", "merge",
      "clean", "filter-branch", "filter-repo", "gc", "submodule", "credential", "branch", "tag", "stash", "clone",
    ],
    npm: ["publish", "login", "logout", "adduser", "token", "owner", "unpublish", "deprecate", "config"],
    pnpm: ["publish", "login", "logout", "config"],
    yarn: ["publish", "login", "logout", "config"],
    dotnet: ["nuget"],
  },
  deniedPatterns: [
    { pattern: /\$\(|`|<\(|>\(/, reason: "command substitution is not allowed" },
    { pattern: /(^|\s)(-g|--global|--location=global)(\s|$)/, reason: "global installs are not allowed" },
    { pattern: /\b(sudo|su|doas|ssh|scp|rsync|nc|ncat|telnet|mkfs|dd|shutdown|reboot|chown|crontab|eval)\b/, reason: "privileged or remote command" },
    { pattern: /\b(curl|wget)\b/, reason: "network downloads must go through a package manager" },
    { pattern: /\.claude\b|\.codex\b|auth\.json|\.credentials|\.netrc|\.npmrc|\.ssh\b|keychain|id_rsa|id_ed25519/i, reason: "access to credential files is not allowed" },
    { pattern: /rm\s+(-[a-zA-Z]*\s+)*(\/|~|\*)(\s|$)/, reason: "refusing a broad rm" },
  ],
};

export interface CommandCheck {
  ok: boolean;
  reason?: string;
}

/** Split a command line into words, honouring quotes; operators become their own tokens. */
export function tokenize(command: string): string[] | undefined {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let hasToken = false;
  const push = () => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i] as string;
    if (quote) {
      if (ch === quote) quote = undefined;
      else if (ch === "\\" && quote === '"' && i + 1 < command.length) current += command[++i];
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      hasToken = true;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += command[++i];
      hasToken = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (ch === "\n") {
        push();
        tokens.push(";");
      } else push();
      continue;
    }
    if (command.startsWith("2>&1", i) || command.startsWith("1>&2", i)) {
      push();
      tokens.push(command.slice(i, i + 4));
      i += 3;
      continue;
    }
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === ">>" || two === "2>" || two === "&>") {
      push();
      tokens.push(two);
      i++;
      continue;
    }
    if (ch === ";" || ch === "|" || ch === "&" || ch === ">" || ch === "<") {
      push();
      tokens.push(ch);
      continue;
    }
    current += ch;
    hasToken = true;
  }
  if (quote) return undefined;
  push();
  return tokens;
}

const SEPARATORS = new Set(["&&", "||", ";", "|", "&"]);
const REDIRECTS = new Set([">", ">>", "<", "2>", "&>", "2>&1", "1>&2"]);
const SAFE_ABSOLUTE = new Set(["/dev/null", "/dev/stdout", "/dev/stderr"]);

/**
 * Check a command line against the policy. `root` is the folder the agent is
 * locked to; `cwd` is where the command runs (inside root).
 */
export function checkCommand(command: string, root: string, cwd = root, policy = DEFAULT_COMMAND_POLICY): CommandCheck {
  const trimmed = command.trim();
  if (!trimmed) return { ok: false, reason: "empty command" };
  for (const { pattern, reason } of policy.deniedPatterns) {
    if (pattern.test(trimmed)) return { ok: false, reason };
  }
  const tokens = tokenize(trimmed);
  if (!tokens) return { ok: false, reason: "unbalanced quotes" };

  let segment: string[] = [];
  let workdir = cwd;
  const segments: string[][] = [];
  for (const token of tokens) {
    if (SEPARATORS.has(token)) {
      if (segment.length) segments.push(segment);
      segment = [];
    } else segment.push(token);
  }
  if (segment.length) segments.push(segment);

  for (const seg of segments) {
    // Leading VAR=value assignments.
    let start = 0;
    while (start < seg.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(seg[start] as string)) start++;
    const words = seg.slice(start);
    const program = words[0];
    if (!program) continue;
    const base = program.includes("/") ? path.basename(program) : program;
    if (program.includes("/") && !program.startsWith("./") && !program.startsWith("node_modules/.bin/")) {
      return { ok: false, reason: `run programs by name, not path: ${program}` };
    }
    if (!policy.programs.includes(base) && !program.startsWith("./") && !program.startsWith("node_modules/.bin/")) {
      return { ok: false, reason: `"${base}" is not on the command allow-list` };
    }
    const denied = policy.deniedSubcommands[base];
    if (denied) {
      const sub = words.slice(1).find((w) => !w.startsWith("-"));
      if (sub && denied.includes(sub)) return { ok: false, reason: `"${base} ${sub}" is not allowed` };
    }
    // Path-like arguments must stay inside the root.
    for (let i = 1; i < words.length; i++) {
      const word = words[i] as string;
      if (REDIRECTS.has(word)) continue;
      const candidate = word.includes("=") && !word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word.replace(/^--?[\w-]+=/, "");
      const reason = checkPathArg(candidate, root, workdir);
      if (reason) return { ok: false, reason };
    }
    if (base === "cd") {
      const target = words[1] ?? root;
      workdir = path.resolve(workdir, target);
    }
  }
  return { ok: true };
}

function checkPathArg(word: string, root: string, cwd: string): string | undefined {
  if (!word) return undefined;
  if (word.startsWith("~")) return `home-directory paths are not allowed: ${word}`;
  if (word.startsWith("/")) {
    if (SAFE_ABSOLUTE.has(word)) return undefined;
    // "/api" or "/^x/d" are URL paths / regexes, not files: only treat it as a
    // path when its top-level directory really exists on this machine.
    const top = word.split("/")[1];
    if (!top || !existsSync(`/${top}`)) return word === "/" ? "the filesystem root is outside the project folder" : undefined;
    return isWithin(root, path.resolve(word)) ? undefined : `absolute path outside the project folder: ${word}`;
  }
  if (word.split(/[\\/]/).includes("..")) {
    return isWithin(root, path.resolve(cwd, word)) ? undefined : `path escapes the project folder: ${word}`;
  }
  return undefined;
}
