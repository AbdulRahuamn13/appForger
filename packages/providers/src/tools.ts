import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";
import type { AccessPolicy, AgentEventPayload } from "@appforge/core";
import { truncate } from "@appforge/core";
import { canWrite, Sandbox } from "@appforge/workspace";

/**
 * Vendor-neutral tools for API-key adapters (which, unlike the CLIs, have no
 * built-in file access). Every path goes through the Sandbox and every
 * command through the allow-list, so a model can't leave the project folder.
 */
export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema for the input object. */
  parameters: {
    type: "object";
    properties: Record<string, { type: string; description: string }>;
    required: string[];
    additionalProperties: false;
  };
}

export interface ToolContext {
  sandbox: Sandbox;
  access: AccessPolicy;
  checkCommand?: (command: string) => string | undefined;
  signal?: AbortSignal;
}

export interface ToolOutcome {
  output: string;
  isError: boolean;
  events: AgentEventPayload[];
}

const SKIP_DIRS = new Set(["node_modules", ".git", ".appforge", "dist", "bin", "obj", ".venv", "__pycache__"]);
const MAX_OUTPUT = 30_000;

const str = (description: string) => ({ type: "string", description });
const num = (description: string) => ({ type: "integer", description });

const ALL_TOOLS: ToolSpec[] = [
  {
    name: "list_files",
    description: "List files under a directory (relative to the project root), skipping node_modules/.git. Returns one path per line.",
    parameters: { type: "object", properties: { path: str("Directory, default '.'") }, required: [], additionalProperties: false },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file. Optionally a line window.",
    parameters: {
      type: "object",
      properties: { path: str("File path relative to the project root"), offset: num("First line (1-based)"), limit: num("Max lines") },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "search",
    description: "Search file contents with a JavaScript regular expression. Returns path:line: text matches.",
    parameters: {
      type: "object",
      properties: { pattern: str("Regular expression"), path: str("Directory to search, default '.'") },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Create or overwrite a file with the given content. Parent folders are created.",
    parameters: {
      type: "object",
      properties: { path: str("File path relative to the project root"), content: str("Full file content") },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace one exact, unique occurrence of old_string with new_string in a file.",
    parameters: {
      type: "object",
      properties: { path: str("File path"), old_string: str("Exact text to replace (must be unique)"), new_string: str("Replacement text") },
      required: ["path", "old_string", "new_string"],
      additionalProperties: false,
    },
  },
  {
    name: "run_command",
    description: "Run a shell command in the project root (allow-listed programs only: npm, npx, pnpm, node, python, pytest, dotnet, git status/diff/log, ls, cat, grep…). Returns exit code and output.",
    parameters: {
      type: "object",
      properties: { command: str("Command line"), timeout_seconds: num("Timeout, default 300") },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

const WRITE_TOOLS = new Set(["write_file", "edit_file"]);

export function toolsFor(access: AccessPolicy): ToolSpec[] {
  return ALL_TOOLS.filter((t) => {
    if (WRITE_TOOLS.has(t.name)) return access.mode !== "read-only";
    if (t.name === "run_command") return access.shell;
    return true;
  });
}

export async function runTool(name: string, input: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  const args = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  const events: AgentEventPayload[] = [];
  const fail = (message: string): ToolOutcome => ({ output: message, isError: true, events });
  const strArg = (key: string): string | undefined => (typeof args[key] === "string" ? (args[key] as string) : undefined);
  const numArg = (key: string): number | undefined => (typeof args[key] === "number" ? (args[key] as number) : undefined);

  try {
    switch (name) {
      case "list_files": {
        const dir = await ctx.sandbox.resolve(strArg("path") ?? ".");
        const files: string[] = [];
        await walk(dir, ctx.sandbox, files, 1_000);
        return { output: files.join("\n") || "(empty)", isError: false, events };
      }
      case "read_file": {
        const rel = strArg("path");
        if (!rel) return fail("path is required");
        const file = await ctx.sandbox.resolve(rel);
        const text = await readFile(file, "utf8");
        const lines = text.split("\n");
        const offset = Math.max(1, numArg("offset") ?? 1);
        const limit = numArg("limit") ?? 2_000;
        const window = lines.slice(offset - 1, offset - 1 + limit);
        const numbered = window.map((l, i) => `${String(offset + i).padStart(5)}\t${l}`).join("\n");
        return { output: truncate(numbered, MAX_OUTPUT), isError: false, events };
      }
      case "search": {
        const pattern = strArg("pattern");
        if (!pattern) return fail("pattern is required");
        let regex: RegExp;
        try {
          regex = new RegExp(pattern);
        } catch (err) {
          return fail(`Invalid regex: ${(err as Error).message}`);
        }
        const dir = await ctx.sandbox.resolve(strArg("path") ?? ".");
        const files: string[] = [];
        await walk(dir, ctx.sandbox, files, 5_000);
        const hits: string[] = [];
        for (const rel of files) {
          const abs = path.join(ctx.sandbox.root, rel);
          const st = await stat(abs);
          if (st.size > 1_000_000) continue;
          const text = await readFile(abs, "utf8").catch(() => "");
          if (text.includes("\u0000")) continue;
          text.split("\n").forEach((line, i) => {
            if (hits.length < 300 && regex.test(line)) hits.push(`${rel}:${i + 1}: ${truncate(line.trim(), 300)}`);
          });
          if (hits.length >= 300) break;
        }
        return { output: hits.join("\n") || "No matches", isError: false, events };
      }
      case "write_file":
      case "edit_file": {
        const rel = strArg("path");
        if (!rel) return fail("path is required");
        const file = await ctx.sandbox.resolve(rel);
        const relative = ctx.sandbox.relative(file);
        if (!canWrite(ctx.access, relative)) return fail(`Not allowed to write ${relative} with this role's access`);
        let existed = true;
        let current = "";
        try {
          current = await readFile(file, "utf8");
        } catch {
          existed = false;
        }
        let next: string;
        if (name === "write_file") {
          const content = strArg("content");
          if (content === undefined) return fail("content is required");
          next = content;
        } else {
          const oldString = strArg("old_string");
          const newString = strArg("new_string");
          if (!existed) return fail(`${relative} does not exist`);
          if (oldString === undefined || newString === undefined) return fail("old_string and new_string are required");
          const count = current.split(oldString).length - 1;
          if (count === 0) return fail("old_string not found");
          if (count > 1) return fail(`old_string matches ${count} times; include more context`);
          next = current.replace(oldString, () => newString);
        }
        await mkdir(path.dirname(file), { recursive: true });
        await writeFile(file, next);
        events.push({ type: "file-change", path: relative, kind: existed ? "update" : "add" });
        return { output: `${existed ? "Updated" : "Created"} ${relative}`, isError: false, events };
      }
      case "run_command": {
        const command = strArg("command");
        if (!command) return fail("command is required");
        if (!ctx.access.shell) return fail("Shell commands are disabled for this role");
        const blocked = ctx.checkCommand?.(command);
        if (blocked) return fail(`Command blocked by the allow-list: ${blocked}`);
        const timeout = Math.min(Math.max(numArg("timeout_seconds") ?? 300, 1), 1_800) * 1000;
        const result = await execa("/bin/sh", ["-c", command], {
          cwd: ctx.sandbox.root,
          reject: false,
          all: true,
          timeout,
          stdin: "ignore",
          cancelSignal: ctx.signal,
          env: { ...process.env, CI: "1", FORCE_COLOR: "0" },
        });
        const output = String(result.all ?? "");
        events.push({ type: "command", command, exitCode: result.exitCode ?? -1, output: truncate(output, 4_000) });
        return {
          output: `exit code ${result.exitCode ?? "?"}${result.timedOut ? " (timed out)" : ""}\n${truncate(output, MAX_OUTPUT)}`,
          isError: result.exitCode !== 0,
          events,
        };
      }
      default:
        return fail(`Unknown tool: ${name}`);
    }
  } catch (err) {
    return fail((err as Error).message);
  }
}

async function walk(dir: string, sandbox: Sandbox, out: string[], max: number): Promise<void> {
  if (out.length >= max) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    if (out.length >= max) return;
    if (entry.isSymbolicLink()) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(full, sandbox, out, max);
    } else if (entry.isFile()) {
      out.push(sandbox.relative(full));
    }
  }
}
