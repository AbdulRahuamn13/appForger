import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AgentEventPayload, AgentSession, AuthStatus, ProviderAdapter, RoleId, SessionOptions, TurnInput } from "@appforge/core";
import { newId } from "@appforge/core";
import { Sandbox } from "@appforge/workspace";

export interface ScriptContext {
  role: RoleId;
  prompt: string;
  cwd: string;
  /** 0 for the first sendTask of a session. */
  turn: number;
  /** Global call counter across all sessions of this adapter. */
  call: number;
  /** Reference images passed for this turn. */
  images: string[];
  systemPrompt: string;
}

export interface ScriptStep {
  text: string;
  /** Files to write, relative to the session cwd. Written as-is (policy is enforced later by the orchestrator). */
  files?: Record<string, string>;
  deleteFiles?: string[];
  /** Simulate a failure. */
  error?: string;
  rateLimited?: boolean;
  delayMs?: number;
}

export type Script = (ctx: ScriptContext) => ScriptStep | Promise<ScriptStep>;

/**
 * A deterministic provider driven by a script function. Used by tests, and
 * by the built-in "demo" provider so the whole pipeline can be exercised
 * without spending plan limits.
 */
export class ScriptedAdapter implements ProviderAdapter {
  readonly vendor = "appforge";
  readonly authKind = "api-key" as const;
  readonly models = [] as const;
  readonly defaultModel = undefined;
  private calls = 0;
  readonly log: ScriptContext[] = [];

  constructor(
    private readonly script: Script,
    readonly id = "scripted",
    readonly label = "Scripted (test)",
  ) {}

  async checkAuth(): Promise<AuthStatus> {
    return { ok: true, installed: true, detail: "Built in; no account needed" };
  }

  async startSession(options: SessionOptions): Promise<AgentSession> {
    const sandbox = await Sandbox.create(options.cwd);
    let turn = 0;
    let stopped = false;
    const next = (prompt: string, images: string[]): ScriptContext => {
      const ctx: ScriptContext = { role: options.role, prompt, cwd: options.cwd, turn: turn++, call: this.calls++, images, systemPrompt: options.systemPrompt };
      this.log.push(ctx);
      return ctx;
    };
    const script = this.script;
    return {
      id: newId("sc"),
      async *sendTask(prompt: string, input?: TurnInput): AsyncIterable<AgentEventPayload> {
        stopped = false;
        const ctx = next(prompt, input?.images ?? []);
        yield { type: "session-start", model: "scripted" };
        const step = await script(ctx);
        if (step.delayMs) await new Promise((r) => setTimeout(r, step.delayMs));
        if (stopped) {
          yield { type: "session-end", status: "stopped" };
          return;
        }
        for (const [rel, content] of Object.entries(step.files ?? {})) {
          const target = await sandbox.resolve(rel);
          await mkdir(path.dirname(target), { recursive: true });
          await writeFile(target, content);
          yield { type: "file-change", path: rel, kind: "update" };
        }
        for (const rel of step.deleteFiles ?? []) {
          await rm(await sandbox.resolve(rel), { force: true });
          yield { type: "file-change", path: rel, kind: "delete" };
        }
        yield { type: "text", text: step.text };
        yield { type: "usage", inputTokens: prompt.length, outputTokens: step.text.length, costUsd: 0 };
        if (step.error) {
          yield { type: "error", message: step.error, ...(step.rateLimited ? { rateLimited: true } : {}) };
          yield { type: "session-end", status: "failed", result: step.text };
          return;
        }
        yield { type: "session-end", status: "completed", result: step.text };
      },
      async stop() {
        stopped = true;
      },
    };
  }
}
