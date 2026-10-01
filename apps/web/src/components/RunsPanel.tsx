import { Play } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project, Run, RunMode } from "@appforge/core";
import { Badge, statusTone } from "./ui/badge.tsx";
import { Button } from "./ui/button.tsx";
import { Field, Select, Textarea } from "./ui/input.tsx";
import { Empty, ErrorNote } from "./ui/misc.tsx";
import { RunApi } from "@/lib/api.ts";
import { href, navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { cn, timeAgo } from "@/lib/utils.ts";

export const MODES: { value: RunMode; label: string; description: string }[] = [
  { value: "pipeline", label: "Pipeline", description: "Architect → Coder → Reviewer → Test author → Integrator, one task at a time. Predictable and cheap." },
  { value: "swarm", label: "Swarm", description: "Architect splits the work; parallel coders in separate git worktrees, capped by your concurrency setting." },
  { value: "single", label: "Single agent", description: "One agent on one branch; you steer it turn by turn, then review and merge." },
  { value: "swarm-native", label: "Claude agent team", description: "Hands the brief to Claude Code's experimental Agent Teams (Claude only), then reviews and merges." },
];

export function RunsPanel({ project }: { project: Project }) {
  const [runs, setRuns] = useState<Run[]>();
  const [mode, setMode] = useState<RunMode>("pipeline");
  const [brief, setBrief] = useState("");
  const [repo, setRepo] = useState(project.repos[0]?.path ?? ".");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    RunApi.list(project.id).then(setRuns, (e: Error) => setError(e.message));
  }, [project.id]);
  useServerMessages((msg) => {
    if (msg.kind !== "run-updated" || msg.run.projectId !== project.id) return;
    setRuns((list) => {
      const rest = (list ?? []).filter((r) => r.id !== msg.run.id);
      return [msg.run, ...rest].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    });
  });

  const start = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const run = await RunApi.create(project.id, { mode, brief, ...(project.shape === "separate" && (mode === "single" || mode === "swarm-native") ? { repo } : {}) });
      navigate({ page: "run", id: run.id });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="text-sm font-semibold">New run</h3>
        <div className="grid gap-2 sm:grid-cols-4" role="radiogroup" aria-label="Run mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              onClick={() => setMode(m.value)}
              className={cn("rounded-md border p-3 text-left transition-colors hover:border-primary/50", mode === m.value && "border-primary bg-primary/5 ring-1 ring-primary/30")}
            >
              <div className="text-sm font-medium">{m.label}</div>
              <div className="mt-1 text-xs text-muted-foreground">{m.description}</div>
            </button>
          ))}
        </div>
        <Field label="Brief" hint="What should be built? Be specific about features, data and screens.">
          <Textarea value={brief} onChange={(e) => setBrief(e.target.value)} rows={4} placeholder="A todo API (create, list, complete, delete) and a React list UI with a form to add todos." aria-label="Brief" />
        </Field>
        {project.shape === "separate" && (mode === "single" || mode === "swarm-native") && (
          <Field label="Repository">
            <Select value={repo} onChange={(e) => setRepo(e.target.value)}>
              {project.repos.map((r) => (
                <option key={r.path} value={r.path}>
                  {r.path}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <ErrorNote error={error} />
        <Button onClick={() => void start()} disabled={busy || !brief.trim()}>
          <Play /> Start {MODES.find((m) => m.value === mode)?.label.toLowerCase()} run
        </Button>
      </section>

      <section>
        <h3 className="mb-2 text-sm font-semibold">Runs</h3>
        {runs?.length === 0 && <Empty>No runs yet.</Empty>}
        <ul className="divide-y rounded-md border">
          {runs?.map((r) => (
            <li key={r.id}>
              <a href={href({ page: "run", id: r.id })} className="flex items-center gap-3 px-3 py-2.5 hover:bg-muted/50">
                <Badge tone={statusTone(r.status)}>{r.status}</Badge>
                <span className="w-24 shrink-0 text-xs text-muted-foreground">{MODES.find((m) => m.value === r.mode)?.label}</span>
                <span className="min-w-0 flex-1 truncate text-sm">{r.brief}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
