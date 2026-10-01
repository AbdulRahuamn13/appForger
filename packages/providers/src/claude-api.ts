import Anthropic from "@anthropic-ai/sdk";
import type { AgentEventPayload, AgentSession, AuthStatus, ProviderAdapter, SessionOptions } from "@appforge/core";
import { newId } from "@appforge/core";
import { Sandbox } from "@appforge/workspace";
import type { SecretStore } from "./secrets.ts";
import { runTool, toolsFor, type ToolSpec } from "./tools.ts";

type MessageParam = Anthropic.Beta.Messages.BetaMessageParam;
type ToolResult = Anthropic.Beta.Messages.BetaToolResultBlockParam;

/** USD per million tokens (input, output) for cost tracking. */
const PRICES: Record<string, [number, number]> = {
  "claude-opus-5-5": [4, 20],
  "claude-sonnet-5-5": [2, 10],
  "claude-fable-5-1": [10, 50],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-4-5": [1, 5],
};

/** Models that accept the server-side refusal fallback chain (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export const DEFAULT_CLAUDE_MODEL = "claude-opus-5-5";

/**
 * Claude via the Anthropic API with the user's own API key from the OS
 * keychain. The model gets AppForge's sandboxed file/command tools.
 */
export class ClaudeApiAdapter implements ProviderAdapter {
  readonly id = "claude-api";
  readonly label = "Claude API (API key)";
  readonly vendor = "anthropic";
  readonly authKind = "api-key" as const;
  readonly models = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1", "claude-haiku-4-5"] as const;
  readonly defaultModel = DEFAULT_CLAUDE_MODEL;

  /** `baseURL` is for tests and proxies; requests otherwise go to api.anthropic.com. */
  constructor(
    private readonly secrets: SecretStore,
    private readonly clientOptions: { baseURL?: string } = {},
  ) {}

  async checkAuth(): Promise<AuthStatus> {
    const status = await this.secrets.status("anthropic-api-key");
    if (status.present) return { ok: true, installed: true, detail: `API key found (${status.source})` };
    return {
      ok: false,
      installed: true,
      detail: status.keychainError ? `OS keychain unavailable: ${status.keychainError}` : "No Anthropic API key stored",
      hint: "Add a key on the Providers page (stored in the OS keychain), or set ANTHROPIC_API_KEY for the AppForge server.",
    };
  }

  async startSession(options: SessionOptions): Promise<AgentSession> {
    const apiKey = await this.secrets.get("anthropic-api-key");
    if (!apiKey) throw new Error("No Anthropic API key. Add one on the Providers page.");
    const sandbox = await Sandbox.create(options.cwd);
    return new ClaudeApiSession(new Anthropic({ apiKey, ...this.clientOptions }), options, sandbox);
  }
}

class ClaudeApiSession implements AgentSession {
  readonly id = newId("ca");
  private readonly messages: MessageParam[] = [];
  private abort: AbortController | undefined;
  private readonly model: string;
  private readonly tools: ToolSpec[];

  constructor(
    private readonly client: Anthropic,
    private readonly options: SessionOptions,
    private readonly sandbox: Sandbox,
  ) {
    this.model = options.model || DEFAULT_CLAUDE_MODEL;
    this.tools = toolsFor(options.access);
  }

  async *sendTask(prompt: string): AsyncIterable<AgentEventPayload> {
    const abort = new AbortController();
    this.abort = abort;
    this.messages.push({ role: "user", content: prompt });
    yield { type: "session-start", model: this.model };
    const maxTurns = this.options.maxTurns ?? 80;
    let lastText = "";
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const stream = this.client.beta.messages.stream(
          {
            model: this.model,
            max_tokens: 64_000,
            system: this.options.systemPrompt,
            messages: this.messages,
            tools: this.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters })),
            ...(this.model.includes("haiku") ? {} : { output_config: { effort: "high" as const } }),
            // Refusal fallback: the API re-runs a declined request on a suitable model.
            ...(FALLBACK_MODELS.has(this.model) ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const } : {}),
          },
          { signal: abort.signal },
        );
        let turnText = "";
        for await (const event of stream) {
          if (event.type === "content_block_delta" && event.delta.type === "text_delta") turnText += event.delta.text;
        }
        const message = await stream.finalMessage();
        // Append the full content (including any fallback blocks) unchanged.
        this.messages.push({ role: "assistant", content: message.content });
        const [inPrice, outPrice] = PRICES[this.model] ?? [0, 0];
        const usage = message.usage;
        const inputTokens = usage.input_tokens + (usage.cache_read_input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0);
        yield {
          type: "usage",
          inputTokens,
          outputTokens: usage.output_tokens,
          costUsd: (inputTokens * inPrice + usage.output_tokens * outPrice) / 1_000_000,
        };
        if (turnText.trim()) {
          lastText = turnText;
          yield { type: "text", text: turnText };
        }
        if (message.stop_reason === "refusal") {
          yield { type: "error", message: `Claude declined the request${message.stop_details?.category ? ` (${message.stop_details.category})` : ""}` };
          yield { type: "session-end", status: "failed", result: lastText };
          return;
        }
        const toolUses = message.content.filter((b): b is Anthropic.Beta.Messages.BetaToolUseBlock => b.type === "tool_use");
        if (message.stop_reason === "pause_turn") continue;
        if (message.stop_reason === "max_tokens" && toolUses.length === 0) {
          this.messages.push({ role: "user", content: "Continue from where you stopped." });
          continue;
        }
        if (toolUses.length === 0) {
          yield { type: "session-end", status: "completed", result: lastText };
          return;
        }
        const results: ToolResult[] = [];
        for (const use of toolUses) {
          yield { type: "tool-call", tool: use.name, input: JSON.stringify(use.input).slice(0, 2_000) };
          // A max_tokens cut can leave the last tool input truncated; don't run it.
          const truncated = message.stop_reason === "max_tokens" && use === toolUses[toolUses.length - 1];
          const outcome = truncated
            ? { output: "Tool input was cut off by the output limit; send it again.", isError: true, events: [] }
            : await runTool(use.name, use.input, {
                sandbox: this.sandbox,
                access: this.options.access,
                signal: abort.signal,
                ...(this.options.checkCommand ? { checkCommand: this.options.checkCommand } : {}),
              });
          yield* outcome.events;
          yield { type: "tool-result", tool: use.name, output: outcome.output.slice(0, 4_000), isError: outcome.isError };
          results.push({ type: "tool_result", tool_use_id: use.id, content: outcome.output, ...(outcome.isError ? { is_error: true } : {}) });
        }
        // All results for this turn go back in a single user message.
        this.messages.push({ role: "user", content: results });
      }
      yield { type: "warning", message: `Stopped after ${maxTurns} turns` };
      yield { type: "session-end", status: "completed", result: lastText };
    } catch (err) {
      if (abort.signal.aborted) {
        yield { type: "session-end", status: "stopped", result: lastText };
        return;
      }
      yield { type: "error", message: describeError(err), rateLimited: err instanceof Anthropic.RateLimitError };
      yield { type: "session-end", status: "failed", result: lastText };
    } finally {
      this.abort = undefined;
    }
  }

  async stop(): Promise<void> {
    this.abort?.abort();
  }
}

function describeError(err: unknown): string {
  if (err instanceof Anthropic.AuthenticationError) return "Anthropic API key was rejected (401)";
  if (err instanceof Anthropic.RateLimitError) return "Anthropic API rate limit (429)";
  if (err instanceof Anthropic.NotFoundError) return `Model or endpoint not found: ${err.message}`;
  if (err instanceof Anthropic.APIError) return `Anthropic API error ${err.status ?? ""}: ${err.message}`;
  return (err as Error).message;
}
