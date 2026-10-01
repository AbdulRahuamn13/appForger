import OpenAI from "openai";
import type { AgentEventPayload, AgentSession, AuthStatus, ProviderAdapter, SessionOptions, TurnInput } from "@appforge/core";
import { newId } from "@appforge/core";
import { Sandbox } from "@appforge/workspace";
import { loadImages } from "./images.ts";
import type { SecretStore } from "./secrets.ts";
import { runTool, toolsFor, type ToolSpec } from "./tools.ts";

type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

export const DEFAULT_OPENAI_MODEL = "gpt-5";

/**
 * OpenAI models via the Chat Completions API with the user's own key from the
 * OS keychain, using the same sandboxed tools as the Claude API adapter.
 */
export class OpenAiApiAdapter implements ProviderAdapter {
  readonly id = "openai-api";
  readonly label = "OpenAI API (API key)";
  readonly vendor = "openai";
  readonly authKind = "api-key" as const;
  readonly models = ["gpt-5", "gpt-5-mini", "o4-mini"] as const;
  readonly defaultModel = DEFAULT_OPENAI_MODEL;

  /** `baseURL` is for tests and OpenAI-compatible gateways. */
  constructor(
    private readonly secrets: SecretStore,
    private readonly clientOptions: { baseURL?: string } = {},
  ) {}

  async checkAuth(): Promise<AuthStatus> {
    const status = await this.secrets.status("openai-api-key");
    if (status.present) return { ok: true, installed: true, detail: `API key found (${status.source})` };
    return {
      ok: false,
      installed: true,
      detail: status.keychainError ? `OS keychain unavailable: ${status.keychainError}` : "No OpenAI API key stored",
      hint: "Add a key on the Providers page (stored in the OS keychain), or set OPENAI_API_KEY for the AppForge server.",
    };
  }

  async startSession(options: SessionOptions): Promise<AgentSession> {
    const apiKey = await this.secrets.get("openai-api-key");
    if (!apiKey) throw new Error("No OpenAI API key. Add one on the Providers page.");
    const sandbox = await Sandbox.create(options.cwd);
    return new OpenAiSession(new OpenAI({ apiKey, ...this.clientOptions }), options, sandbox);
  }
}

class OpenAiSession implements AgentSession {
  readonly id = newId("oa");
  private readonly messages: ChatMessage[];
  private abort: AbortController | undefined;
  private readonly model: string;
  private readonly tools: ToolSpec[];

  constructor(
    private readonly client: OpenAI,
    private readonly options: SessionOptions,
    private readonly sandbox: Sandbox,
  ) {
    this.model = options.model || DEFAULT_OPENAI_MODEL;
    this.tools = toolsFor(options.access);
    this.messages = [{ role: "system", content: options.systemPrompt }];
  }

  async *sendTask(prompt: string, turn?: TurnInput): AsyncIterable<AgentEventPayload> {
    const abort = new AbortController();
    this.abort = abort;
    const images = await loadImages(turn?.images);
    this.messages.push({
      role: "user",
      content: images.length
        ? [
            { type: "text", text: prompt },
            ...images.map((img) => ({ type: "image_url" as const, image_url: { url: `data:${img.mediaType};base64,${img.base64}` } })),
          ]
        : prompt,
    });
    yield { type: "session-start", model: this.model };
    const maxTurns = this.options.maxTurns ?? 80;
    let lastText = "";
    try {
      for (let turn = 0; turn < maxTurns; turn++) {
        const completion = await this.client.chat.completions.create(
          {
            model: this.model,
            messages: this.messages,
            tools: this.tools.map((t) => ({ type: "function" as const, function: { name: t.name, description: t.description, parameters: t.parameters } })),
          },
          { signal: abort.signal },
        );
        if (completion.usage) {
          yield { type: "usage", inputTokens: completion.usage.prompt_tokens, outputTokens: completion.usage.completion_tokens };
        }
        const choice = completion.choices[0];
        if (!choice) throw new Error("OpenAI returned no choices");
        const msg = choice.message;
        this.messages.push(msg);
        if (msg.content?.trim()) {
          lastText = msg.content;
          yield { type: "text", text: msg.content };
        }
        const calls = (msg.tool_calls ?? []).filter((c) => c.type === "function");
        if (calls.length === 0) {
          yield { type: "session-end", status: "completed", result: lastText };
          return;
        }
        for (const call of calls) {
          let input: unknown;
          try {
            input = JSON.parse(call.function.arguments || "{}");
          } catch {
            input = undefined;
          }
          yield { type: "tool-call", tool: call.function.name, input: call.function.arguments.slice(0, 2_000) };
          const outcome =
            input === undefined
              ? { output: "Arguments were not valid JSON; send the call again.", isError: true, events: [] }
              : await runTool(call.function.name, input, {
                  sandbox: this.sandbox,
                  access: this.options.access,
                  signal: abort.signal,
                  ...(this.options.checkCommand ? { checkCommand: this.options.checkCommand } : {}),
                });
          yield* outcome.events;
          yield { type: "tool-result", tool: call.function.name, output: outcome.output.slice(0, 4_000), isError: outcome.isError };
          this.messages.push({ role: "tool", tool_call_id: call.id, content: outcome.output });
        }
      }
      yield { type: "warning", message: `Stopped after ${maxTurns} turns` };
      yield { type: "session-end", status: "completed", result: lastText };
    } catch (err) {
      if (abort.signal.aborted) {
        yield { type: "session-end", status: "stopped", result: lastText };
        return;
      }
      const rateLimited = err instanceof OpenAI.RateLimitError;
      const message = err instanceof OpenAI.APIError ? `OpenAI API error ${err.status ?? ""}: ${err.message}` : (err as Error).message;
      yield { type: "error", message, rateLimited };
      yield { type: "session-end", status: "failed", result: lastText };
    } finally {
      this.abort = undefined;
    }
  }

  async stop(): Promise<void> {
    this.abort?.abort();
  }
}
