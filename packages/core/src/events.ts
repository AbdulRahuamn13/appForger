import type { Approval, Project, RoleId, Run, Story, Task, TestReport } from "./domain.ts";

/**
 * What a provider adapter emits while an agent works. Adapters translate their
 * vendor's structured output (SDK messages, `codex exec --json` lines, API
 * stream events) into these payloads; nothing downstream knows the vendor.
 */
export type AgentEventPayload =
  | { type: "session-start"; model?: string; sessionId?: string }
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool-call"; tool: string; input: string }
  | { type: "tool-result"; tool: string; output: string; isError: boolean }
  | { type: "file-change"; path: string; kind: "add" | "update" | "delete" }
  | { type: "command"; command: string; exitCode?: number; output?: string }
  | { type: "usage"; inputTokens: number; outputTokens: number; costUsd?: number }
  | { type: "warning"; message: string }
  | { type: "error"; message: string; rateLimited?: boolean }
  | { type: "session-end"; status: "completed" | "failed" | "stopped"; result?: string };

export type AgentEventType = AgentEventPayload["type"];

/** Context the orchestrator stamps on every payload before publishing it. */
export interface AgentEventEnvelope {
  id: string;
  runId: string;
  taskId?: string;
  /** Unique per agent session within a run, e.g. "coder-2". */
  agentId: string;
  role: RoleId;
  provider: string;
  ts: string;
}

export type AgentEvent = AgentEventEnvelope & AgentEventPayload;

/** Orchestrator-level log lines (not from an agent). */
export interface RunLogEvent {
  runId: string;
  taskId?: string;
  level: "info" | "warn" | "error";
  message: string;
  ts: string;
}

/** Everything the server pushes to the UI over the WebSocket hub. */
export type ServerMessage =
  | { kind: "hello"; version: string }
  | { kind: "project-updated"; project: Project }
  | { kind: "run-updated"; run: Run }
  | { kind: "task-updated"; task: Task }
  | { kind: "agent-event"; event: AgentEvent }
  | { kind: "run-log"; log: RunLogEvent }
  | { kind: "approval-updated"; approval: Approval }
  | { kind: "test-report"; runId: string; taskId?: string; report: TestReport }
  | { kind: "playground-event"; playgroundId: string; payload: AgentEventPayload }
  | { kind: "story-updated"; story: Story }
  | { kind: "story-deleted"; storyId: string; projectId: string }
  | { kind: "log-saved"; projectId: string; name: string }
  | { kind: "preview-updated"; projectId: string; preview: PreviewState };

export interface PreviewState {
  status: "stopped" | "starting" | "running" | "failed";
  frontendUrl?: string;
  backendUrl?: string;
  error?: string;
  /** Recent dev-server output. */
  output: string;
}

/** Messages the UI can send over the socket. Mutations go through REST. */
export type ClientMessage = { kind: "subscribe"; runId?: string } | { kind: "ping" };
