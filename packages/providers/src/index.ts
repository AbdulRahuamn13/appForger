import { ClaudeApiAdapter } from "./claude-api.ts";
import { ClaudeCodeAdapter } from "./claude-code.ts";
import { CodexCliAdapter } from "./codex-cli.ts";
import { createDemoAdapter } from "./demo.ts";
import { OpenAiApiAdapter } from "./openai-api.ts";
import { ProviderRegistry } from "./registry.ts";
import type { SecretStore } from "./secrets.ts";

export * from "./claude-api.ts";
export * from "./claude-code.ts";
export * from "./codex-cli.ts";
export * from "./demo.ts";
export * from "./images.ts";
export * from "./openai-api.ts";
export * from "./registry.ts";
export * from "./scripted.ts";
export * from "./secrets.ts";
export * from "./tools.ts";

/** The default set of adapters. Adding a vendor = one more adapter here. */
export function createDefaultRegistry(secrets: SecretStore, options: { demo?: boolean } = {}): ProviderRegistry {
  const registry = new ProviderRegistry([
    new ClaudeCodeAdapter(),
    new CodexCliAdapter(),
    new ClaudeApiAdapter(secrets),
    new OpenAiApiAdapter(secrets),
  ]);
  if (options.demo) registry.register(createDemoAdapter());
  return registry;
}
