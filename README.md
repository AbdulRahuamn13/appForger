# AppForge

A personal, local multi-agent app builder. You give it a brief and a folder; it
drives coding agents — **Claude Code** and **OpenAI Codex CLI** on your own
subscriptions, or API-key models — through an Architect → Coder → Reviewer →
Test author → Integrator workflow, and merges reviewed, tested code into a git
repo on your machine.

The full design is in [docs/PLAN.md](docs/PLAN.md).

## The one rule

AppForge **never handles subscription logins or tokens**. You sign in once with
the vendors' own CLIs (`claude`, `codex login`); AppForge only launches those
tools and checks their status (`claude auth status`, `codex login status`).
API keys, if you use them, go into your OS keychain and are never written to
files, logs, or the database. Keep it a single-user local tool; anyone else
should run their own copy with their own accounts.

## Requirements

- Node.js 22+, pnpm 10, git
- [Claude Code](https://docs.claude.com/en/docs/claude-code) signed in with your Pro/Max account: `npm i -g @anthropic-ai/claude-code`, then run `claude` once and `/login`
- Optional: Codex CLI signed in with ChatGPT: `npm i -g @openai/codex && codex login`
- Optional: Anthropic / OpenAI API keys (added on the Providers page)
- For the stacks you generate: Python 3.11+ (FastAPI), .NET 8 SDK (ASP.NET Core)

## Run it

```bash
pnpm install
pnpm start          # builds the UI, serves everything at http://127.0.0.1:4317
```

Other ways to run:

| Command | What it does |
|---|---|
| `pnpm dev` | Server with reload on :4317 + Vite UI on http://127.0.0.1:5173 |
| `pnpm demo` | Like `start`, plus a free **Demo** provider with canned output, so you can watch a full pipeline/swarm run (branches, worktrees, approvals, merges) without spending plan limits |
| `pnpm desktop` | Optional Electron window with a native folder picker. First run `pnpm --filter @appforge/desktop setup` to download Electron |

Environment variables: `APPFORGE_HOME` (data dir, default `~/.appforge`),
`APPFORGE_PORT` (default 4317), `APPFORGE_HOST` (default 127.0.0.1),
`APPFORGE_DEMO=1`, `APPFORGE_LOG=1` (request logs). `ANTHROPIC_API_KEY` /
`OPENAI_API_KEY` are used as a fallback when the OS keychain has no key
(handy on machines without a keychain).

## Using it

1. **Providers** — check that Claude Code (and Codex) show *Signed in*. Use
   *Try a prompt* to stream one prompt through any provider.
2. **New project** — pick or create a folder (server-side folder browser, or
   the native dialog in the desktop app). Choose a stack (Node/Express + React,
   FastAPI + React, ASP.NET Core + React, or Custom), monorepo or two separate
   repos, and your unit/E2E frameworks. AppForge runs `git init`, writes the
   starter files and test scaffolding, and commits them.
3. **Settings** — pick provider + model per role (e.g. Claude codes, Codex
   reviews), swarm concurrency, fix-loop limit, per-run budget, and whether
   every merge needs your approval. Switching Playwright ↔ Cypress scaffolds
   the new framework immediately. *Generate GitHub Actions workflow* writes a
   CI file running the same commands.
4. **Runs** — pick a mode and write a brief:

   | Mode | How it runs |
   |---|---|
   | Pipeline | Architect writes `docs/SPEC.md`, `docs/openapi.yaml` and a task list; each task then goes Coder → Reviewer → Test author → tests → approval → merge, one at a time |
   | Swarm | Same, but up to *N* coders run in parallel, each in its own git worktree with its own file ownership; tasks start when their dependencies have merged |
   | Single agent | One coder on one branch; you steer it turn by turn, then *Finish* runs review + tests and asks you to approve the merge |
   | Claude agent team | Hands the brief to Claude Code's experimental Agent Teams (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`), then reviews, tests and merges the result |

5. **Run page** — task board, live logs per agent, approval cards with a
   side-by-side Monaco diff (approve, send back with a comment, or reject),
   test results, and tokens/cost per agent. *Stop* ends a run; the sidebar's
   **Kill switch** stops every agent, test runner and dev server at once.
   Runs pause on plan/rate limits and resume where they stopped; after a
   restart, interrupted runs resume from their saved tasks.

## What happens on disk

- Each task gets a branch `appforge/<run>/<task>` and a worktree under
  `<repo>/.appforge/worktrees/` (git-ignored locally, never committed).
- AppForge commits each step itself (`feat(...)`, `test(...)`, merge commits);
  agents are told not to run history-changing git commands, and the allow-list
  blocks them.
- Your main checkout must be on its base branch with no uncommitted changes
  when AppForge merges; otherwise the run pauses and tells you what to fix.
- Data (projects, runs, events) lives in SQLite at `$APPFORGE_HOME/appforge.db`.

## Guardrails

- **Folder sandbox** — every path an agent touches is resolved through real
  paths; `..` and symlink escapes are rejected (Claude Code via a PreToolUse
  hook + `canUseTool`, API models via sandboxed tools, Codex via
  `-C <dir> -s workspace-write|read-only`).
- **Role scopes, enforced twice** — Reviewer is read-only, Test author may
  only write test files, Architect only docs. After every agent turn AppForge
  checks what actually changed in git and reverts anything outside the role's
  scope (and, in swarms, outside the task's file ownership).
- **Command allow-list** — package managers, test runners, read-only git and
  file utilities; no `sudo`, `curl | sh`, `git push`, global installs,
  credential paths, or paths outside the folder. It is a best-effort filter,
  not a VM: an agent that can run `node` can still run arbitrary code inside
  your user account, so use approvals and review the diffs.
- **Approval gate, budget cap, kill switch**, and a localhost-only server that
  rejects other hosts/origins (DNS-rebinding / cross-site protection).

## Development

```bash
pnpm test        # unit + integration tests (scripted providers, real git)
pnpm test:slow   # also runs real Vitest, pytest and Playwright against a scaffolded app (needs network)
pnpm lint
pnpm typecheck
```

Layout:

```
apps/server         Fastify API, WebSocket hub, SQLite (Drizzle), wires everything
apps/web            React + Vite + Tailwind UI (shadcn-style components, Monaco, xterm.js)
apps/desktop        Optional Electron wrapper
packages/core       Shared types: Project, Run, Task, AgentEvent, ProviderAdapter, TestRunnerAdapter
packages/providers  claude-code, codex-cli, claude-api, openai-api (+ scripted/demo)
packages/orchestrator  Single, pipeline, swarm, Claude-native modes; task board; merges
packages/workspace  Sandbox, command allow-list, git worktrees, process registry
packages/testing    Playwright, Cypress, Vitest, Jest, xUnit, pytest adapters + E2E app runner
packages/templates  Stack templates and role prompts
```

Adding a vendor = one `ProviderAdapter` in `packages/providers`; adding a test
framework = one `TestRunnerAdapter` in `packages/testing`. The orchestrator has
no provider- or framework-specific code.
