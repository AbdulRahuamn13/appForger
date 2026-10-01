import type { RoleId } from "./domain.ts";
import type { AgentEventPayload } from "./events.ts";

/**
 * How much an agent may change. Enforced twice: by the adapter while the agent
 * runs (tool hooks, vendor sandbox flags) and by the orchestrator afterwards
 * (changed files are checked against `writable` and reverted on violation).
 */
export interface AccessPolicy {
  /** "read-only": no writes at all. "scoped": only paths matching `writable`. "full": anything in cwd. */
  mode: "read-only" | "scoped" | "full";
  /** Glob patterns relative to cwd, used when mode is "scoped". */
  writable?: string[];
  /** Whether shell commands are allowed (always filtered by the command allow-list). */
  shell: boolean;
}

export interface SessionOptions {
  /** Absolute folder the agent is locked to (project folder or a task worktree). */
  cwd: string;
  role: RoleId;
  model?: string;
  systemPrompt: string;
  access: AccessPolicy;
  /** Max agentic turns per sendTask, where the vendor supports it. */
  maxTurns?: number;
  /** Extra environment for CLI-based adapters (never credentials). */
  env?: Record<string, string>;
  /** Called for every shell command the agent wants to run; return a reason to block it. */
  checkCommand?: (command: string) => string | undefined;
}

export interface AuthStatus {
  /** Ready to run prompts. */
  ok: boolean;
  /** The CLI/SDK is present on this machine. */
  installed: boolean;
  /** Human-readable status, e.g. "Signed in (claude.ai)" or "No API key in keychain". */
  detail: string;
  /** How to fix it, shown in the UI. */
  hint?: string;
}

/** Extra input for one turn. */
export interface TurnInput {
  /** Absolute paths of reference images (inside the session folder) to show the model. */
  images?: string[];
}

export interface AgentSession {
  readonly id: string;
  /**
   * Send one task/message and stream events until the agent finishes that
   * turn. Calling again continues the same conversation. The stream always
   * ends with a `session-end` event.
   */
  sendTask(prompt: string, input?: TurnInput): AsyncIterable<AgentEventPayload>;
  /** Abort the in-flight turn and release resources. Safe to call twice. */
  stop(): Promise<void>;
}

export interface ProviderAdapter {
  readonly id: string;
  readonly label: string;
  readonly vendor: string;
  /** "subscription" adapters drive the vendor's own signed-in CLI; "api-key" adapters use a keychain key. */
  readonly authKind: "subscription" | "api-key";
  readonly defaultModel?: string;
  /** Suggested models for the UI; free text is allowed too. */
  readonly models: readonly string[];
  checkAuth(): Promise<AuthStatus>;
  startSession(options: SessionOptions): Promise<AgentSession>;
}

/** Collects a whole turn: all events plus the final text. */
export interface TurnResult {
  status: "completed" | "failed" | "stopped";
  text: string;
  events: AgentEventPayload[];
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  rateLimited: boolean;
  error?: string;
}
