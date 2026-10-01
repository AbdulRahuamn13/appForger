import { ExternalLink, FileText, Pencil, RotateCcw, Sparkles, Square, Trash2, Undo2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { LogFileInfo, Project, Run, Story, Task } from "@appforge/core";
import { KnowledgeApi, RunApi, StoryApi } from "@/lib/api.ts";
import { href, navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { timeAgo } from "@/lib/utils.ts";
import { Badge, isBusy, statusTone } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Field, Input, Textarea } from "../ui/input.tsx";
import { Markdown } from "../ui/markdown.tsx";
import { ErrorNote, Spinner } from "../ui/misc.tsx";
import { toast } from "../ui/toast.tsx";
import { ImagePicker } from "./ImagePicker.tsx";
import { PlanReview } from "./PlanReview.tsx";

export const STORY_LABELS: Record<Story["status"], string> = {
  draft: "draft",
  planning: "planning",
  "plan-review": "plan ready",
  running: "building",
  done: "done",
  failed: "failed",
  reverted: "undone",
};

export function StoryDetail({ story, project, onDeleted }: { story: Story; project: Project; onDeleted: () => void }) {
  const [runs, setRuns] = useState<Run[]>([]);
  const [logs, setLogs] = useState<LogFileInfo[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState({ title: story.title, body: story.body, acceptance: story.acceptance, images: story.images });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  const load = () => {
    void StoryApi.get(story.id).then((d) => setRuns(d.runs), () => undefined);
    void KnowledgeApi.logs(project.id).then(setLogs, () => undefined);
  };
  useEffect(load, [story.id, story.status, project.id]);
  useEffect(() => setForm({ title: story.title, body: story.body, acceptance: story.acceptance, images: story.images }), [story]);

  const activeRun = [...runs].reverse().find((r) => ["pending", "running", "paused", "awaiting-approval", "awaiting-input", "interrupted"].includes(r.status));
  const lastBuild = [...runs].reverse().find((r) => r.mode !== "plan");
  useEffect(() => {
    if (!lastBuild) return setTasks([]);
    void RunApi.get(lastBuild.id).then((d) => setTasks(d.tasks), () => undefined);
  }, [lastBuild?.id]);
  useServerMessages((msg) => {
    if (msg.kind === "run-updated" && msg.run.storyId === story.id) setRuns((list) => [...list.filter((r) => r.id !== msg.run.id), msg.run].sort((a, b) => a.createdAt.localeCompare(b.createdAt)));
    if (msg.kind === "task-updated" && msg.task.runId === lastBuild?.id) setTasks((list) => [...list.filter((t) => t.id !== msg.task.id), msg.task].sort((a, b) => a.order - b.order));
    if (msg.kind === "log-saved" && msg.projectId === project.id) void KnowledgeApi.logs(project.id).then(setLogs, () => undefined);
  });

  const act = async (fn: () => Promise<unknown>, done?: string) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
      if (done) toast(done, "success");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const logFor = (run: Run) => logs.find((l) => l.name.endsWith(`${run.id.slice(-6)}.txt`));
  const editable = !["planning", "running"].includes(story.status);

  return (
    <div className="space-y-6" data-testid="story-detail">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-1.5">
          <Badge tone={statusTone(story.status)} dot pulse={isBusy(story.status)} data-testid="story-status">
            {STORY_LABELS[story.status]}
          </Badge>
          <h2 className="text-lg font-semibold tracking-tight">{story.title}</h2>
          {story.outcome && <p className="text-[13px] text-muted-foreground">{story.outcome}</p>}
        </div>
        {editable && !editing && (
          <div className="flex shrink-0 gap-1">
            <Button variant="ghost" size="icon" onClick={() => setEditing(true)} aria-label="Edit story">
              <Pencil />
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label="Delete story"
              onClick={() => {
                if (confirm(`Delete "${story.title}"? Code already merged stays.`)) void act(async () => {
                  await StoryApi.remove(story.id);
                  onDeleted();
                });
              }}
            >
              <Trash2 />
            </Button>
          </div>
        )}
      </div>

      {editing ? (
        <div className="space-y-4">
          <Field label="Title">
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </Field>
          <Field label="What should be built?">
            <Textarea value={form.body} onChange={(e) => setForm({ ...form, body: e.target.value })} rows={5} />
          </Field>
          <Field label="Acceptance criteria">
            <Textarea value={form.acceptance} onChange={(e) => setForm({ ...form, acceptance: e.target.value })} rows={3} />
          </Field>
          <Field label="Reference images">
            <ImagePicker projectId={project.id} value={form.images} onChange={(images) => setForm({ ...form, images })} />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              disabled={busy}
              onClick={() =>
                void act(async () => {
                  await StoryApi.update(story.id, form);
                  setEditing(false);
                })
              }
            >
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="space-y-4">
          {story.body && <Markdown>{story.body}</Markdown>}
          {story.acceptance && (
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">Acceptance criteria</div>
              <Markdown>{story.acceptance}</Markdown>
            </div>
          )}
          <ImagePicker projectId={project.id} value={story.images} readOnly />
        </div>
      )}

      <ErrorNote error={error} />

      {!editing && story.status === "draft" && (
        <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
          <p className="text-[13px] text-muted-foreground">The planner reads the code, history and your images, then proposes a plan. Nothing is built until you approve it.</p>
          <Button disabled={busy} onClick={() => void act(() => StoryApi.plan(story.id))}>
            <Sparkles /> Plan this story
          </Button>
        </div>
      )}

      {story.status === "planning" && (
        <div className="flex items-center justify-between gap-4 rounded-lg border px-4 py-3">
          <span className="flex items-center gap-2 text-[13px]">
            <Spinner /> The planner is working{story.plan ? " on a revision" : ""}…
          </span>
          {activeRun && (
            <div className="flex gap-1">
              <Button variant="ghost" size="sm" onClick={() => navigate({ page: "run", id: activeRun.id })}>
                <ExternalLink /> Watch
              </Button>
              <Button variant="ghost" size="sm" onClick={() => void act(() => RunApi.stop(activeRun.id))}>
                <Square /> Stop
              </Button>
            </div>
          )}
        </div>
      )}

      {story.status === "running" && (
        <div className="space-y-3 rounded-lg border px-4 py-3">
          <div className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-2 text-[13px]">
              <Spinner /> Building with {story.mode}
              {activeRun && activeRun.status !== "running" && <Badge tone={statusTone(activeRun.status)} dot>{activeRun.status}</Badge>}
            </span>
            {activeRun && (
              <Button size="sm" onClick={() => navigate({ page: "run", id: activeRun.id })}>
                <ExternalLink /> Open run
              </Button>
            )}
          </div>
          {tasks.length > 0 && (
            <ul className="space-y-1">
              {tasks.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-2 text-[13px]">
                  <span className="truncate">{t.title}</span>
                  <Badge tone={statusTone(t.status)} dot pulse={isBusy(t.status)}>
                    {t.status}
                  </Badge>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {story.plan && (story.status === "plan-review" || story.status === "failed") && !editing && <PlanReview key={`${story.plan.version}-${story.updatedAt}`} story={story} project={project} />}
      {story.plan && ["running", "done", "reverted"].includes(story.status) && (
        <details className="rounded-lg border px-4 py-3">
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Approved plan (v{story.plan.version})</summary>
          <div className="mt-4">
            <PlanReview story={story} project={project} readOnly />
          </div>
        </details>
      )}

      {(story.status === "done" || story.status === "failed") && (
        <div className="flex flex-wrap justify-end gap-2">
          {story.status === "failed" && (
            <Button variant="outline" disabled={busy} onClick={() => void act(() => StoryApi.plan(story.id), "Re-planning")}>
              <RotateCcw /> Re-plan
            </Button>
          )}
          <Button
            variant="ghost"
            disabled={busy}
            onClick={() => {
              if (confirm("Undo this story? AppForge reverts its merges with new commits (history is kept).")) void act(() => StoryApi.undo(story.id), "Story undone");
            }}
          >
            <Undo2 /> Undo story
          </Button>
        </div>
      )}

      {runs.length > 0 && (
        <div>
          <div className="mb-2 text-xs font-medium text-muted-foreground">History</div>
          <ul className="divide-y rounded-lg border">
            {[...runs].reverse().map((r) => {
              const log = logFor(r);
              return (
                <li key={r.id} className="flex items-center gap-3 px-3 py-2 text-[13px]">
                  <Badge tone={statusTone(r.status)} dot>
                    {r.status}
                  </Badge>
                  <span className="w-20 text-muted-foreground">{r.mode === "plan" ? "plan" : r.mode}</span>
                  <span className="flex-1 text-xs text-muted-foreground">{timeAgo(r.createdAt)}</span>
                  {log && (
                    <a className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={href({ page: "project", id: project.id, tab: "logs", item: log.name })}>
                      <FileText className="size-3" /> log
                    </a>
                  )}
                  <a className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground" href={href({ page: "run", id: r.id })}>
                    <ExternalLink className="size-3" /> run
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
