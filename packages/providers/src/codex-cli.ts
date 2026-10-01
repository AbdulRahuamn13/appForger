import { execa, type ResultPromise } from "execa";
import type { AgentEventPayload, AgentSession, AuthStatus, ProviderAdapter, SessionOptions } from "@appforge/core";
import { isRateLimitMessage, isRecord, newId, truncate } from "@appforge/core";

/**
 * Drives the OpenAI Codex CLI headlessly (`codex exec --json`), signed in with
 * the user's ChatGPT plan or key via `codex login`. AppForge only checks
 * `codex login status`; it never touches ~/.codex.
 *
 * Codex enforces its own sandbox: read-only roles get `-s read-only`, others
 * `-s workspace-write` locked to the session folder with `-C`. Per-path rules
 * (test author, architect) are enforced afterwards by the orchestrator.
 */
export class CodexCliAdapter implements ProviderAdapter {
  readonly id = "codex-cli";
  readonly label = "Codex CLI (ChatGPT)";
  readonly vendor = "openai";
  readonly authKind = "subscription" as const;
  readonly models = ["gpt-5-codex", "gpt-5", "o4-mini"] as const;
  readonly defaultModel = undefined;

  constructor(private readonly options: { codexBinary?: string } = {}) {}

  get binary(): string {
    return this.options.codexBinary ?? "codex";
  }

  async checkAuth(): Promise<AuthStatus> {
    try {
      const res = await execa(this.binary, ["login", "status"], { reject: false, timeout: 20_000, stdin: "ignore", all: true });
      const text = String(res.all ?? "").trim();
      if (res.failed && res.exitCode === undefined) throw Object.assign(new Error(res.shortMessage ?? "not found"), { code: "ENOENT" });
      if (res.exitCode === 0) return { ok: true, installed: true, detail: firstLine(text) || "Signed in" };
      return { ok: false, installed: true, detail: firstLine(text) || "Not signed in", hint: "Run `codex login` in a terminal and sign in with ChatGPT." };
    } catch (err) {
      return {
        ok: false,
        installed: false,
        detail: /ENOENT/.test((err as Error).message) ? "Codex CLI not found on PATH" : `Could not run codex: ${(err as Error).message}`,
        hint: "Install with `npm i -g @openai/codex`, then run `codex login`.",
      };
    }
  }

  async startSession(options: SessionOptions): Promise<AgentSession> {
    return new CodexSession(options, this.binary);
  }
}

class CodexSession implements AgentSession {
  readonly id = newId("cx");
  private threadId: string | undefined;
  private child: ResultPromise | undefined;
  private stopped = false;

  constructor(
    private readonly options: SessionOptions,
    private readonly binary: string,
  ) {}

  private args(resume: boolean): string[] {
    const { options } = this;
    const args = [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "-C",
      options.cwd,
      "-s",
      options.access.mode === "read-only" ? "read-only" : "workspace-write",
    ];
    if (options.model) args.push("-m", options.model);
    if (resume && this.threadId) args.push("resume", this.threadId, "-");
    else args.push("-");
    return args;
  }

  async *sendTask(prompt: string): AsyncIterable<AgentEventPayload> {
    this.stopped = false;
    const resume = Boolean(this.threadId);
    // `codex exec` has no system-prompt flag, so instructions lead the first prompt.
    const input = resume ? prompt : `# Instructions\n${this.options.systemPrompt}\n\n# Task\n${prompt}`;
    const queue = new AsyncQueue<AgentEventPayload>();
    let lastMessage = "";
    let failed = false;
    let sawCompletion = false;

    const child = execa(this.binary, this.args(resume), {
      cwd: this.options.cwd,
      input,
      reject: false,
      env: { ...process.env, ...this.options.env },
      buffer: { stdout: false, stderr: true },
    });
    this.child = child;

    let buffered = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let nl: number;
      while ((nl = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, nl).trim();
        buffered = buffered.slice(nl + 1);
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue; // non-JSON noise
        }
        for (const event of translateCodexEvent(parsed)) {
          if (event.type === "session-start" && event.sessionId) this.threadId = event.sessionId;
          if (event.type === "text") lastMessage = event.text;
          if (event.type === "error") failed = true;
          if (event.type === "usage") sawCompletion = true;
          queue.push(event);
        }
      }
    });
    child.then(
      (result) => {
        if (this.stopped) queue.push({ type: "session-end", status: "stopped", result: lastMessage });
        else if (result.exitCode !== 0 && !sawCompletion) {
          const stderr = truncate(String(result.stderr ?? "").trim(), 2_000);
          queue.push({ type: "error", message: `codex exited with ${result.exitCode}: ${stderr}`, rateLimited: isRateLimitMessage(stderr) });
          queue.push({ type: "session-end", status: "failed", result: lastMessage });
        } else queue.push({ type: "session-end", status: failed ? "failed" : "completed", result: lastMessage });
        queue.close();
      },
      (err: Error) => {
        queue.push({ type: "error", message: err.message });
        queue.push({ type: "session-end", status: "failed", result: lastMessage });
        queue.close();
      },
    );
    yield { type: "session-start", ...(this.options.model ? { model: this.options.model } : {}) };
    yield* queue;
    this.child = undefined;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.child?.kill("SIGTERM");
  }
}

/** Map one `codex exec --json` line to AppForge events. Exported for contract tests. */
export function translateCodexEvent(raw: unknown): AgentEventPayload[] {
  if (!isRecord(raw)) return [];
  const type = typeof raw.type === "string" ? raw.type : "";
  switch (type) {
    case "thread.started":
      return typeof raw.thread_id === "string" ? [{ type: "session-start", sessionId: raw.thread_id }] : [];
    case "turn.completed": {
      const usage = isRecord(raw.usage) ? raw.usage : {};
      const n = (v: unknown) => (typeof v === "number" ? v : 0);
      return [{ type: "usage", inputTokens: n(usage.input_tokens) + n(usage.cached_input_tokens), outputTokens: n(usage.output_tokens) }];
    }
    case "turn.failed": {
      const message = isRecord(raw.error) && typeof raw.error.message === "string" ? raw.error.message : "turn failed";
      return [{ type: "error", message, rateLimited: isRateLimitMessage(message) }];
    }
    case "error": {
      const message = typeof raw.message === "string" ? raw.message : "codex error";
      return [{ type: "error", message, rateLimited: isRateLimitMessage(message) }];
    }
    case "item.started":
    case "item.completed":
      return translateItem(raw.item, type === "item.completed");
    default:
      return [];
  }
}

function translateItem(item: unknown, completed: boolean): AgentEventPayload[] {
  if (!isRecord(item)) return [];
  const kind = typeof item.type === "string" ? item.type : "";
  const text = typeof item.text === "string" ? item.text : "";
  switch (kind) {
    case "agent_message":
      return completed && text ? [{ type: "text", text }] : [];
    case "reasoning":
      return completed && text ? [{ type: "thinking", text }] : [];
    case "command_execution": {
      const command = typeof item.command === "string" ? item.command : "";
      if (!completed) return [{ type: "tool-call", tool: "shell", input: command }];
      const event: AgentEventPayload = { type: "command", command, output: truncate(typeof item.aggregated_output === "string" ? item.aggregated_output : "", 4_000) };
      if (typeof item.exit_code === "number") event.exitCode = item.exit_code;
      return [event];
    }
    case "file_change": {
      if (!completed || !Array.isArray(item.changes)) return [];
      return item.changes.filter(isRecord).map((c) => ({
        type: "file-change" as const,
        path: typeof c.path === "string" ? c.path : "?",
        kind: c.kind === "add" || c.kind === "delete" ? c.kind : ("update" as const),
      }));
    }
    case "mcp_tool_call":
      return completed ? [] : [{ type: "tool-call", tool: `${String(item.server ?? "mcp")}.${String(item.tool ?? "?")}`, input: truncate(JSON.stringify(item.arguments ?? {}), 2_000) }];
    case "web_search":
      return completed ? [] : [{ type: "tool-call", tool: "web_search", input: typeof item.query === "string" ? item.query : "" }];
    case "error":
      return [{ type: "warning", message: typeof item.message === "string" ? item.message : "codex reported an error" }];
    default:
      return [];
  }
}

function firstLine(text: string): string {
  return text.split("\n").find((l) => l.trim())?.trim() ?? "";
}

/** Minimal push/pull async queue bridging callbacks to an async iterator. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private readonly items: T[] = [];
  private waiting: ((r: IteratorResult<T>) => void) | undefined;
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: item, done: false });
    } else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      resolve({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        if (this.items.length) return Promise.resolve({ value: this.items.shift() as T, done: false });
        if (this.closed) return Promise.resolve({ value: undefined, done: true });
        return new Promise((resolve) => (this.waiting = resolve));
      },
    };
  }
}
