# AppForge — Multi-Agent App Builder: Build Plan

_Oct 1, 2026 · Abdul Codingo_

## Feasibility: yes, for personal use, if the app drives the official CLIs

Yes, this can be built. The one rule that shapes everything: **the app must never
handle subscription logins or tokens itself.** It launches the vendors' own coding
agents (Claude Code and OpenAI Codex CLI) on your machine, already signed in with
your own accounts, and orchestrates them.

- **Claude Pro/Max.** Anthropic's docs say subscription OAuth tokens are meant for
  Claude Code and Claude.ai only, and third-party developers may not offer
  Claude.ai login or route requests through Pro/Max credentials on behalf of their
  users (Claude Code legal and compliance). Anthropic staff have said personal use
  and local development with the Agent SDK and `claude -p` are fine; a product for
  other people should use an API key. A planned separate monthly "Agent SDK
  credit" was paused on 15 June 2026; for now SDK and `claude -p` usage still draws
  from your normal plan limits (Help Center). Re-check that page before you rely
  on it.
- **ChatGPT Plus/Pro.** Codex CLI supports "Sign in with ChatGPT" and runs headless
  with `codex exec`, billed against your plan (Codex auth docs).

### What this means for the design

- Auth = the user runs `claude` and `codex login` once in a terminal. The app only
  checks status; it never reads, copies or proxies tokens.
- API keys are a second, fully supported mode (Anthropic, OpenAI, others), stored
  in the OS keychain.
- Keep it a single-user local tool. If it ever becomes a product for others, switch
  those users to API keys.
- Plan limits are the real ceiling: a swarm of 5 agents burns a Pro plan fast.
  Max 5x/20x is the realistic tier for swarms.

## Scope: a local desktop-style web app that turns a brief into a working full-stack repo

AppForge runs on your machine, opens in the browser at localhost, and builds apps
into a folder you pick. MVP features:

| Feature | MVP behaviour |
|---|---|
| Project folder | Pick or create a folder; the app runs `git init` and works only inside it |
| Project shape | Monorepo (backend + frontend together) or two separate repos |
| Stack templates | Preset pairs, e.g. ASP.NET Core + React, Node/Express + React, FastAPI + React; custom allowed |
| Providers | Claude (subscription via Claude Code, or API key) and OpenAI (ChatGPT via Codex CLI, or API key); pluggable for more |
| Agent roles | Architect, Coder (backend/frontend), Reviewer, Test author, Integrator |
| Run modes | Single agent, Pipeline (code → review → test), Swarm (parallel agents on worktrees) |
| Test automation | Choose Playwright, Cypress, or none for E2E; xUnit/Vitest/Jest/pytest for unit |
| Model per role | e.g. Claude codes, Codex reviews (cross-vendor review catches more) |
| Live view | Streamed agent logs, file diffs, task board, test results, usage per agent |
| Safety | Approval gates before merge, command allow-list, folder sandbox, kill switch |

Out of scope for v1: cloud hosting, multi-user accounts, deploying the generated apps.

## Architecture: a thin orchestrator over pluggable agent and test adapters

Four layers: **UI** (React) → **Server** (Fastify + WebSocket hub + SQLite) →
**Orchestrator** (modes, task board, merge logic) → **Adapters** (providers,
test runners, workspace/git).

The orchestrator never talks to a model directly; it asks a provider adapter to run
a role in a folder, so adding Gemini CLI or another vendor later is one new
adapter. Subscription adapters launch the vendor's own CLI, which holds the login.

## Tech stack: TypeScript end to end, because the agent SDKs are TypeScript-first

The orchestrator is TypeScript so it can use `@anthropic-ai/claude-agent-sdk`
directly. A .NET backend is possible, but you would be shelling out to the CLIs for
everything; keep .NET as a generated-app template instead.

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript, pnpm workspaces | One language across server, UI and adapters |
| Server | Fastify + WebSocket | Streams agent events to the UI |
| Storage | SQLite via Drizzle ORM | Projects, runs, tasks, events; zero setup |
| UI | React + Vite + Tailwind + shadcn/ui | Fast to build, familiar |
| Code views | Monaco diff editor, xterm.js log panes | Review diffs and live agent output |
| Processes | execa (and node-pty where a TTY is needed) | Spawn claude, codex, test runners |
| Git | simple-git | Branches, worktrees, merges per agent |
| Secrets | OS keychain via @napi-rs/keyring | API keys never in plain files |
| Packaging | Local web app first; optional Electron wrap later | Electron adds a native folder picker |

Repo layout:

```
appforge/
  apps/
    server/          Fastify API, orchestrator, WebSocket hub
    web/             React UI
  packages/
    core/            Shared types: Project, Run, Task, AgentEvent
    providers/       ProviderAdapter + claude-code, claude-api, codex-cli, openai-api
    orchestrator/    Modes: single, pipeline, swarm; task queue; merge logic
    workspace/       Folder sandbox, git worktrees, command allow-list
    testing/         TestRunnerAdapter + playwright, cypress, unit runners
    templates/       Stack templates and agent role prompts
  CLAUDE.md
  docs/PLAN.md       This plan, exported as Markdown
```

## Agents and run modes: five roles, three modes, swarm is opt-in

Each role is a prompt + tool permissions + a provider/model you choose in the UI.

| Role | Does | Can write code? | Suggested default |
|---|---|---|---|
| Architect | Turns the brief into a spec, API contract (OpenAPI), and a task list | Docs only | Claude (Opus-class) |
| Coder | Implements one task on its own branch/worktree; backend and frontend coders can run in parallel | Yes, own worktree only | Claude or Codex |
| Reviewer | Reviews each diff for bugs, security, contract drift; returns approve or change requests | No (read-only sandbox) | The other vendor from the coder |
| Test author | Writes unit tests and E2E specs in the chosen framework | Test folders only | Claude or Codex |
| Integrator | Merges approved branches, resolves conflicts, runs the full test suite, reports | Yes, main branch | Claude |

| Mode | How it runs | Use when |
|---|---|---|
| Single | One agent, one session, you steer | Small changes, exploration |
| Pipeline | Architect → Coder → Reviewer → Test author → Integrator, one task at a time | Default; predictable, cheap |
| Swarm (AppForge) | Architect splits work; N coders run at once in separate git worktrees; reviewers and test authors pick up finished tasks from a shared board; Integrator merges | Bigger builds; mixed Claude + Codex |
| Swarm (Claude native) | Hands the run to Claude Code's experimental Agent Teams, where a lead session spawns teammates that share a task list and message each other | Claude-only, when you want Claude to self-coordinate |

Swarm rules: one task = one worktree = one branch; agents never share a working
copy; concurrency cap set in the UI (start at 3); every merge passes review + tests
first.

## Test automation: one adapter interface, framework chosen per project

Every runner implements the same `TestRunnerAdapter`: `scaffold()`,
`run(filter?)`, `parseResults()` (JUnit XML or JSON reporter) → a common
`TestReport`. Adding a framework = one new adapter.

| Framework | Layer | Scaffold | Run headless | Results |
|---|---|---|---|---|
| Playwright | E2E | `npm init playwright@latest` | `npx playwright test` | JSON / JUnit reporter |
| Cypress | E2E | `npm i -D cypress` + config | `npx cypress run` | JUnit reporter |
| Vitest / Jest | Frontend unit | Template config | `npx vitest run` | JSON reporter |
| xUnit / NUnit | .NET backend unit | `dotnet new xunit` | `dotnet test --logger trx` | TRX |
| pytest | Python backend | Template config | `pytest --junitxml` | JUnit XML |

How it fits the flow:

- Project setup asks for unit and E2E frameworks; the Test author agent gets those
  as hard constraints.
- The orchestrator, not the agent, runs tests and starts the app (backend +
  frontend dev servers on free ports) before E2E.
- Failures go back to the Coder as a structured report (test name, error,
  trace/screenshot path) for a bounded number of fix loops (default 3).
- Optional: generate a GitHub Actions workflow that runs the same commands in CI.

## Build plan: seven phases, each a Claude Code session with a clear finish line

Run each phase in plan mode first, approve the plan, then let it build. Commit at
the end of every phase.

### Phase 0 — Setup (30 min)

- [ ] Install Node 22, pnpm, git, Claude Code; sign in to Claude Code with your Pro/Max account
- [ ] Install Codex CLI (`npm i -g @openai/codex`) and run `codex login` with ChatGPT
- [x] Create appforge/, git init, add the CLAUDE.md and this plan as docs/PLAN.md

### Phase 1 — Skeleton and project folders

Scaffold the pnpm monorepo from the repo layout. Build the Fastify server with a
WebSocket hub, SQLite via Drizzle (tables: projects, runs, tasks, events), and the
React UI shell. Add a server-side folder browser so I can pick or create a project
folder; on create, run `git init` and save the project. No agents yet.

**Done when:** you can create a project in a chosen folder from the UI and see it
listed after restart.

### Phase 2 — Provider adapters

Implement packages/providers with a `ProviderAdapter` interface (checkAuth,
startSession, sendTask, stream events, stop). Adapters: claude-code (Claude Agent
SDK, using the local Claude Code login, cwd locked to the project folder),
codex-cli (spawn `codex exec --json -C <dir> -s workspace-write`), claude-api and
openai-api (keys from the OS keychain). Never read or copy any CLI token files.
Add a Providers settings page showing auth status per provider.

**Done when:** one prompt runs through each provider and streams into the UI.

### Phase 3 — Single and Pipeline modes

Implement packages/orchestrator with Single and Pipeline modes and the five role
prompts in packages/templates. Each Coder task runs on its own branch. Reviewer
runs read-only and returns JSON `{verdict, issues[]}`. Add a Monaco diff view and an
approve/reject gate before merge.

**Done when:** a brief like "todo API + React list" goes from spec to merged code
with a review.

### Phase 4 — Test automation

Implement packages/testing with `TestRunnerAdapter` and adapters for Playwright,
Cypress, Vitest, xUnit and pytest. The orchestrator starts backend and frontend on
free ports before E2E, parses results into `TestReport`, and feeds failures back to
the Coder for up to 3 fix loops.

**Done when:** switching Playwright ↔ Cypress in project settings changes what gets
scaffolded and run.

### Phase 5 — Swarm

Add Swarm mode: Architect produces a task DAG; run up to N Coders in parallel, each
in its own git worktree; a task board in the UI; reviewers and test authors pull
finished tasks; the Integrator merges in dependency order and reruns all tests. Add
a 'Claude native' option that launches Claude Code with
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` and streams the lead session.

**Done when:** 3 coders build backend, frontend and auth in parallel with no
shared-file clobbering.

### Phase 6 — Templates and polish

Add stack templates (ASP.NET Core + React, Node + React, FastAPI + React) for
monorepo and separate-repo layouts. Add usage tracking per agent, run resume after
restart, a global kill switch, and an optional Electron wrapper with a native folder
dialog.

**Done when:** you can build a small full-stack app end to end without touching a
terminal.

## Tips for driving Claude Code on this build

- Define the interfaces (`ProviderAdapter`, `TestRunnerAdapter`, `AgentEvent`)
  before any implementation.
- Create project subagents in `.claude/agents/` (e.g. a reviewer) so Claude Code
  reviews its own phases.
- Keep each session to one phase; start fresh with `/clear` between phases so
  context stays small.

## Risks and guardrails

| Risk | Mitigation |
|---|---|
| Subscription terms change (Anthropic's SDK billing for subscriptions is still in flux) | Keep the API-key path first-class; re-check the Help Center before relying on plan limits |
| Swarms exhaust plan limits mid-run | Concurrency cap, per-run budget, pause/resume on limit errors, Pipeline as default |
| Agents run destructive commands | Folder sandbox, command allow-list, Codex workspace-write sandbox, approval gates |
| Parallel agents clobber each other | Worktree per task, Architect assigns file ownership, Integrator merges in order |
| Frontend and backend drift apart | Architect writes the OpenAPI contract first; Reviewer checks diffs against it; generate the TS client from it |
| CLI output formats change | Adapters parse structured JSON output only, pinned CLI versions, adapter contract tests |
| Sharing the tool with teammates | Each person signs in with their own account on their own machine, or uses API keys; never host it with your login |

## Sources

- Use the Claude Agent SDK with your Claude plan — Anthropic Help Center
- Anthropic's Claude subscription policy, explained — Engineer's Codex
- Codex authentication — OpenAI
- Claude Code agent teams — Addy Osmani
