# AppForge

Local, single-user tool that orchestrates coding agents (Claude Code, Codex CLI,
or API-key models) to build full-stack apps in a user-chosen folder.

Full plan: docs/PLAN.md. Work one phase at a time.

## Stack

TypeScript, Node 22, pnpm workspaces. Fastify + WebSocket, SQLite/Drizzle,
React + Vite + Tailwind + shadcn/ui.

## Hard rules

- Never read, copy, log, or proxy Claude or ChatGPT auth tokens/credential files.
  Subscription access is ONLY via the official `claude`/Agent SDK and `codex` CLIs.
- API keys (and cloud storage keys) live in the OS keychain, never in files, logs, or the DB.
- Agents may only touch files inside the selected project folder (resolve and
  check real paths; block symlink escapes).
- Shell commands from agents go through the allow-list in packages/workspace.
- One coder task = one git worktree + branch. Nothing merges without review + tests.

## Conventions

- Shared types live in packages/core; no `any`.
- Each package has Vitest tests; run `pnpm test` before finishing a task.
- Adapters (providers, test runners) implement an interface; no provider-specific
  logic in the orchestrator.

## Commands

pnpm dev | pnpm test | pnpm lint | pnpm build
pnpm demo (free Demo provider) | pnpm test:slow (real test runners, needs network) | pnpm desktop

## Layout

```
apps/server         Fastify API, orchestrator host, WebSocket hub, SQLite (Drizzle)
apps/web            React UI (Vite + Tailwind, shadcn-style components)
apps/desktop        Optional Electron wrapper (native folder dialog)
packages/core       Shared types: Project, Run, Task, AgentEvent, TestReport
packages/providers  ProviderAdapter + claude-code, claude-api, codex-cli, openai-api
packages/orchestrator  Modes: single, pipeline, swarm; task board; merge logic
packages/workspace  Folder sandbox, git worktrees, command allow-list
packages/testing    TestRunnerAdapter + playwright, cypress, vitest, jest, xunit, pytest
packages/templates  Stack templates and agent role prompts
packages/storage    BlobStore (local folder / S3-compatible), skills library (SKILL.md)
```

Work happens through stories: plan run (read-only planner) → human edits /
revises / approves → execution run in the chosen mode → log file + memory.

Packages export their TypeScript sources directly (`exports` → `src/index.ts`);
the server runs through `tsx` and the web app through Vite, so there is no
per-package build step. `pnpm build` = typecheck everything + bundle the UI.
