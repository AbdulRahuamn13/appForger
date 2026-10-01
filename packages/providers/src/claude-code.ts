import path from "node:path";
import { query, type HookCallback, type PermissionResult, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { execa } from "execa";
import type { AgentEventPayload, AgentSession, AuthStatus, ProviderAdapter, SessionOptions, TurnInput } from "@appforge/core";
import { newId, truncate } from "@appforge/core";
import { canWrite, Sandbox } from "@appforge/workspace";
import { imageHint } from "./images.ts";

const WRITE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);
const PATH_KEYS = ["file_path", "notebook_path", "path"];

/**
 * Drives the local Claude Code install through the Claude Agent SDK, using
 * whatever login `claude` already has (Pro/Max subscription or the user's
 * own key). AppForge never reads or copies the credentials: it only runs
 * `claude auth status` and lets the SDK spawn Claude Code.
 */
export class ClaudeCodeAdapter implements ProviderAdapter {
  readonly id = "claude-code";
  readonly label = "Claude Code (subscription)";
  readonly vendor = "anthropic";
  readonly authKind = "subscription" as const;
  readonly models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"] as const;
  readonly defaultModel = undefined;

  constructor(private readonly options: { claudeBinary?: string } = {}) {}

  async checkAuth(): Promise<AuthStatus> {
    const bin = this.options.claudeBinary ?? "claude";
    try {
      const res = await execa(bin, ["auth", "status"], { reject: false, timeout: 20_000, stdin: "ignore" });
      if (res.exitCode === undefined && !res.stdout) throw Object.assign(new Error("not found"), { code: "ENOENT" });
      let status: { loggedIn?: boolean; authMethod?: string; apiProvider?: string } = {};
      try {
        status = JSON.parse(String(res.stdout)) as typeof status;
      } catch {
        // older CLIs print text
      }
      if (status.loggedIn) {
        return { ok: true, installed: true, detail: `Signed in (${status.authMethod ?? "unknown method"}, ${status.apiProvider ?? "anthropic"})` };
      }
      return {
        ok: false,
        installed: true,
        detail: "Claude Code is installed but not signed in",
        hint: "Run `claude` in a terminal and sign in with your Claude account (/login).",
      };
    } catch (err) {
      const missing = (err as NodeJS.ErrnoException).code === "ENOENT" || /ENOENT|not found/i.test((err as Error).message);
      return {
        ok: false,
        installed: !missing,
        detail: missing ? "Claude Code CLI not found on PATH" : `Could not check Claude Code: ${(err as Error).message}`,
        hint: "Install with `npm i -g @anthropic-ai/claude-code`, then run `claude` once to sign in.",
      };
    }
  }

  async startSession(options: SessionOptions): Promise<AgentSession> {
    const sandbox = await Sandbox.create(options.cwd);
    return new ClaudeCodeSession(options, sandbox);
  }
}

class ClaudeCodeSession implements AgentSession {
  readonly id = newId("cc");
  private sdkSessionId: string | undefined;
  private abort: AbortController | undefined;

  constructor(
    private readonly options: SessionOptions,
    private readonly sandbox: Sandbox,
  ) {}

  /** Reason to block a tool call, or undefined to allow it. */
  async guard(toolName: string, input: Record<string, unknown>): Promise<string | undefined> {
    const { access } = this.options;
    if (WRITE_TOOLS.has(toolName) && access.mode === "read-only") return `${this.options.role} is read-only`;
    for (const key of PATH_KEYS) {
      const value = input[key];
      if (typeof value !== "string" || !value) continue;
      let resolved: string;
      try {
        resolved = await this.sandbox.resolve(value);
      } catch (err) {
        return (err as Error).message;
      }
      if (WRITE_TOOLS.has(toolName) && !canWrite(access, this.sandbox.relative(resolved))) {
        return `${this.options.role} may only write ${(access.writable ?? []).join(", ")}`;
      }
    }
    if (toolName === "Bash") {
      if (!access.shell) return "shell commands are disabled for this role";
      const command = typeof input.command === "string" ? input.command : "";
      const blocked = this.options.checkCommand?.(command);
      if (blocked) return `command blocked by AppForge allow-list: ${blocked}`;
    }
    return undefined;
  }

  async *sendTask(task: string, turn?: TurnInput): AsyncIterable<AgentEventPayload> {
    // Claude Code reads images natively with its Read tool.
    const prompt = task + imageHint(turn?.images, this.options.cwd);
    const abort = new AbortController();
    this.abort = abort;
    const { options } = this;

    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const toolInput = (typeof input.tool_input === "object" && input.tool_input !== null ? input.tool_input : {}) as Record<string, unknown>;
      const reason = await this.guard(input.tool_name, toolInput);
      if (!reason) return {};
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
    };

    const canUseTool = async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
      const reason = await this.guard(toolName, input);
      return reason ? { behavior: "deny", message: reason } : { behavior: "allow", updatedInput: input };
    };

    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, options.env);

    let finalText = "";
    let ended = false;
    try {
      const q = query({
        prompt,
        options: {
          cwd: options.cwd,
          abortController: abort,
          systemPrompt: { type: "preset", preset: "claude_code", append: options.systemPrompt },
          // Ignore user/project settings so their permission rules can't widen access;
          // every tool call goes through the hook + canUseTool guard above.
          settingSources: [],
          permissionMode: "default",
          canUseTool,
          hooks: { PreToolUse: [{ hooks: [preToolUse] }] },
          env,
          ...(options.access.mode === "read-only" ? { disallowedTools: [...WRITE_TOOLS] } : {}),
          ...(options.model ? { model: options.model } : {}),
          ...(options.maxTurns ? { maxTurns: options.maxTurns } : {}),
          ...(this.sdkSessionId ? { resume: this.sdkSessionId } : {}),
        },
      });
      for await (const message of q) {
        for (const event of translateClaudeMessage(message, options.cwd)) {
          if (event.type === "session-start" && event.sessionId) this.sdkSessionId = event.sessionId;
          if (event.type === "session-end") {
            ended = true;
            finalText = event.result ?? finalText;
          }
          yield event;
        }
      }
    } catch (err) {
      if (abort.signal.aborted) {
        yield { type: "session-end", status: "stopped", result: finalText };
        return;
      }
      const message = (err as Error).message;
      yield { type: "error", message, rateLimited: /rate.?limit|usage limit|429/i.test(message) };
      yield { type: "session-end", status: "failed", result: finalText };
      return;
    } finally {
      this.abort = undefined;
    }
    if (!ended) yield { type: "session-end", status: abort.signal.aborted ? "stopped" : "completed", result: finalText };
  }

  async stop(): Promise<void> {
    this.abort?.abort();
  }
}

/** Map one Agent SDK message to AppForge events. Exported for tests. */
export function translateClaudeMessage(message: SDKMessage, cwd: string): AgentEventPayload[] {
  const out: AgentEventPayload[] = [];
  switch (message.type) {
    case "system":
      if (message.subtype === "init") out.push({ type: "session-start", model: message.model, sessionId: message.session_id });
      break;
    case "assistant": {
      if (message.error) out.push({ type: "error", message: `Claude error: ${message.error}`, rateLimited: message.error === "rate_limit" });
      const sub = message.parent_tool_use_id ? "  ↳ " : "";
      for (const block of message.message.content) {
        if (block.type === "text" && block.text.trim()) out.push({ type: "text", text: sub + block.text });
        else if (block.type === "thinking" && block.thinking.trim()) out.push({ type: "thinking", text: block.thinking });
        else if (block.type === "tool_use") {
          const input = (block.input ?? {}) as Record<string, unknown>;
          out.push({ type: "tool-call", tool: block.name, input: truncate(JSON.stringify(input), 2_000) });
          const file = typeof input.file_path === "string" ? input.file_path : undefined;
          if (file && WRITE_TOOLS.has(block.name)) {
            const rel = path.isAbsolute(file) ? path.relative(cwd, file) : file;
            out.push({ type: "file-change", path: rel.split(path.sep).join("/"), kind: block.name === "Write" ? "add" : "update" });
          }
          if (block.name === "Bash" && typeof input.command === "string") out.push({ type: "command", command: input.command });
        }
      }
      break;
    }
    case "user": {
      const content = message.message.content;
      if (typeof content === "string") break;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const text =
          typeof block.content === "string"
            ? block.content
            : (block.content ?? []).map((c) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
        out.push({ type: "tool-result", tool: block.tool_use_id, output: truncate(text, 4_000), isError: Boolean(block.is_error) });
      }
      break;
    }
    case "rate_limit_event":
      if (message.rate_limit_info.status === "rejected") {
        const resets = message.rate_limit_info.resetsAt ? ` (resets ${new Date(message.rate_limit_info.resetsAt * 1000).toLocaleString()})` : "";
        out.push({ type: "error", message: `Claude plan limit reached${resets}`, rateLimited: true });
      } else if (message.rate_limit_info.status === "allowed_warning") {
        out.push({ type: "warning", message: "Approaching your Claude plan limit" });
      }
      break;
    case "result": {
      const usage = message.usage;
      out.push({
        type: "usage",
        inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0),
        outputTokens: usage.output_tokens ?? 0,
        costUsd: message.total_cost_usd,
      });
      if (message.subtype === "success" && !message.is_error) {
        out.push({ type: "session-end", status: "completed", result: message.result });
      } else {
        const errors = message.subtype === "success" ? message.result : message.errors.join("; ");
        out.push({ type: "error", message: `Claude Code: ${errors || message.subtype}`, rateLimited: /rate.?limit|usage limit/i.test(errors) });
        out.push({ type: "session-end", status: "failed", result: message.subtype === "success" ? message.result : "" });
      }
      break;
    }
    default:
      break;
  }
  return out;
}
