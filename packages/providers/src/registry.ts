import type { AgentEventPayload, AgentSession, AuthStatus, ProviderAdapter, TurnResult } from "@appforge/core";

export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();

  constructor(adapters: ProviderAdapter[] = []) {
    for (const a of adapters) this.register(a);
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  get(id: string): ProviderAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter) throw new Error(`Unknown provider "${id}". Available: ${[...this.adapters.keys()].join(", ")}`);
    return adapter;
  }

  has(id: string): boolean {
    return this.adapters.has(id);
  }

  list(): ProviderAdapter[] {
    return [...this.adapters.values()];
  }

  async statuses(): Promise<Record<string, AuthStatus>> {
    const entries = await Promise.all(
      this.list().map(async (a) => {
        try {
          return [a.id, await a.checkAuth()] as const;
        } catch (err) {
          return [a.id, { ok: false, installed: false, detail: (err as Error).message }] as const;
        }
      }),
    );
    return Object.fromEntries(entries);
  }
}

/** Drive one sendTask to completion, forwarding every event, and summarise it. */
export async function runTurn(
  session: AgentSession,
  prompt: string,
  onEvent: (event: AgentEventPayload) => void = () => {},
): Promise<TurnResult> {
  const result: TurnResult = { status: "failed", text: "", events: [], inputTokens: 0, outputTokens: 0, costUsd: 0, rateLimited: false };
  const texts: string[] = [];
  for await (const event of session.sendTask(prompt)) {
    result.events.push(event);
    onEvent(event);
    switch (event.type) {
      case "text":
        texts.push(event.text);
        break;
      case "usage":
        result.inputTokens += event.inputTokens;
        result.outputTokens += event.outputTokens;
        result.costUsd += event.costUsd ?? 0;
        break;
      case "error":
        result.error = result.error ? `${result.error}; ${event.message}` : event.message;
        if (event.rateLimited) result.rateLimited = true;
        break;
      case "session-end":
        result.status = event.status;
        if (event.result) result.text = event.result;
        break;
      default:
        break;
    }
  }
  if (!result.text) result.text = texts.join("\n\n");
  return result;
}
