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

1. **Settings → Providers & keys** — check that Claude Code (and Codex) show
   *Signed in*. *Try a prompt* streams one prompt through any provider.
   **Settings → Environment** checks git, Node, Python, .NET, CLIs, keychain
   and storage in one place.
2. **New project** (sidebar `+`) — pick or create a folder, a stack (Node/Express
   + React, FastAPI + React, ASP.NET Core + React, or Custom), monorepo or two
   repos, and your unit/E2E frameworks. AppForge runs `git init`, writes the
   starter files and test scaffolding, and commits them.
3. **Stories** — the main loop, as many stories per project as you like:
   1. *New story*: title, what to build, acceptance criteria (one per line),
      and optional **reference images** (click, drop or paste a mockup). Start
      from a template (CRUD feature, sign up & log in, page from a design…).
   2. *Plan*: a read-only planner reads your code, earlier stories, logs and
      images, then proposes a spec, design notes, open questions and tasks.
      **Nothing is built yet.**
   3. Review the plan: **edit it by hand** (tasks, order, dependencies, file
      ownership, spec), or **send it back with feedback** (e.g. answers to its
      questions) for a new version.
   4. *Approve & build*: choose **how** — Pipeline, Swarm, Single agent or
      Claude agent team (AppForge recommends one from the plan's shape).
   5. Approve merges on the run page (side-by-side diffs, reviewer verdicts,
      test results), then read the run's **log file**. Pick the next story.
   - *Undo story* reverts a finished story's merges with new commits.
4. **Logs** — every plan and build writes a plain-text log (brief, plan,
   tasks, reviews, tests, approvals, usage, full timeline) to the project.
   View, filter and download each one, or all of them as one file.
5. **Memory** — project notes every agent reads (decisions, conventions,
   gotchas). AppForge appends each story's outcome; edit freely.
6. **Preview** — starts the app's backend and frontend from the main branch
   and shows it in the page, so you can check the result without a terminal.
7. **Skills** (sidebar) — reusable instructions for agents, per role, in the
   same `SKILL.md` format Claude Code uses. Eight built-ins (verify before
   done, secure by default, API contract first, accessible UI, design from
   reference images…); create your own, or import a folder such as
   `~/.claude/skills`. Turn skills on or off per project in its settings.
8. **Settings → Storage** — keep skills, logs, memory and reference images in
   a **local folder** or a **cloud** S3-compatible bucket (AWS S3, Cloudflare
   R2, MinIO, Backblaze B2). Switching tests the new location and can copy
   everything across; cloud keys go to the OS keychain.
9. **Project settings** — provider + model per role, swarm concurrency,
   fix-loop limit, per-run budget, merge approvals, skills, and an optional
   GitHub Actions workflow.

Everywhere: **⌘K / Ctrl+K** opens a command palette; light/dark theme in the
sidebar; desktop notifications when a plan is ready, a merge needs approval or
a run finishes (Settings → General); the **Kill switch** stops every agent,
test runner, preview and dev server.

### How agents use your project's history

Before every agent turn AppForge writes `.appforge/context/` (git-ignored)
into the agent's folder: `PROJECT_CONTEXT.md` (memory, every story with its
outcome and plan summary, recent runs), the latest run logs, the story's
reference images and the enabled skills' files. Skills and a pointer to this
folder are added to each agent's instructions, and reference images are sent
to vision-capable models (Claude Code reads them, Codex gets `-i`, API models
get image blocks). Acceptance criteria go to coders and are checked by the
reviewer.

### Why these extras

They target what developers report losing the most time to:
- **AI code that is "almost right, but not quite"** is the top frustration with
  AI tools (45%). Hence plan-first approval, acceptance criteria checked by
  review, a *verify before done* skill, live preview, and one-click undo.
- **Context switching** is the top productivity blocker (72%), and tool
  fragmentation hurts most developers. Hence plans, diffs, logs, preview,
  memory and settings in one window, plus the command palette and notifications.
- **Unclear requirements and poor documentation** come next. Hence stories
  with acceptance criteria, planner questions, project memory, and the
  approved plan committed as `docs/stories/<story>.md`.

Sources: [Stack Overflow 2025 Developer Survey](https://stackoverflow.blog/2025/07/29/developers-remain-willing-but-reluctant-to-use-ai-the-2025-developer-survey-results-are-here/), [The Register on "almost right" AI code](https://www.theregister.com/2025/07/29/coders_are_using_ai_tools/), [Chainguard 2026 Engineering Reality Report](https://www.chainguard.dev/2026-engineering-reality-report), [JetBrains State of Developer Ecosystem 2025](https://blog.jetbrains.com/research/2025/10/state-of-developer-ecosystem-2025/).

## What happens on disk

- Each task gets a branch `appforge/<run>/<task>` and a worktree under
  `<repo>/.appforge/worktrees/` (git-ignored locally, never committed).
- AppForge commits each step itself (`feat(...)`, `test(...)`, merge commits);
  agents are told not to run history-changing git commands, and the allow-list
  blocks them.
- Your main checkout must be on its base branch with no uncommitted changes
  when AppForge merges; otherwise the run pauses and tells you what to fix.
- Data (projects, stories, runs, events) lives in SQLite at `$APPFORGE_HOME/appforge.db`.
- Skills, log files, project memory and reference images live in the storage
  you choose (default `$APPFORGE_HOME/storage`, or a cloud bucket).
- Each approved plan is committed as `docs/stories/<story>.md`.

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
packages/core       Shared types: Project, Story, Run, Task, AgentEvent, ProviderAdapter, TestRunnerAdapter
packages/providers  claude-code, codex-cli, claude-api, openai-api (+ scripted/demo)
packages/orchestrator  Plan, single, pipeline, swarm, Claude-native modes; task board; merges
packages/workspace  Sandbox, command allow-list, git worktrees, process registry
packages/testing    Playwright, Cypress, Vitest, Jest, xUnit, pytest adapters + E2E app runner
packages/templates  Stack templates and role prompts
packages/storage    Local / S3-compatible storage, skills library (SKILL.md)
```

Adding a vendor = one `ProviderAdapter` in `packages/providers`; adding a test
framework = one `TestRunnerAdapter` in `packages/testing`. The orchestrator has
no provider- or framework-specific code.
