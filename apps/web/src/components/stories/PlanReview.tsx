import { ArrowDown, ArrowUp, Check, MessageSquare, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type { PlannedTaskDraft, Project, Story, StoryPlan, TaskArea } from "@appforge/core";
import { StoryApi } from "@/lib/api.ts";
import { navigate } from "@/lib/router.ts";
import { Badge } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Field, Input, Select, Textarea } from "../ui/input.tsx";
import { Markdown } from "../ui/markdown.tsx";
import { ErrorNote } from "../ui/misc.tsx";
import { toast } from "../ui/toast.tsx";
import { ModeChooser } from "./ModeChooser.tsx";

const AREAS: TaskArea[] = ["backend", "frontend", "shared"];
const list = (text: string) =>
  text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);

/** Review the planner's proposal: read it, edit it, send it back with feedback, or approve and choose how to build it. */
export function PlanReview({ story, project, readOnly = false }: { story: Story; project: Project; readOnly?: boolean }) {
  const plan = story.plan as StoryPlan;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<StoryPlan>(plan);
  const [feedback, setFeedback] = useState("");
  const [revising, setRevising] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(undefined);
    try {
      await fn();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const setTask = (i: number, patch: Partial<PlannedTaskDraft>) => setDraft((d) => ({ ...d, tasks: d.tasks.map((t, j) => (j === i ? { ...t, ...patch } : t)) }));
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const tasks = [...d.tasks];
      const [t] = tasks.splice(i, 1);
      if (t) tasks.splice(i + dir, 0, t);
      return { ...d, tasks };
    });

  if (editing) {
    return (
      <div className="space-y-5" data-testid="plan-editor">
        <Field label="Summary">
          <Input value={draft.summary} onChange={(e) => setDraft({ ...draft, summary: e.target.value })} />
        </Field>
        <Field label="Spec (Markdown)">
          <Textarea value={draft.spec} onChange={(e) => setDraft({ ...draft, spec: e.target.value })} rows={12} className="font-mono text-xs" />
        </Field>
        <Field label="Design notes">
          <Textarea value={draft.design ?? ""} onChange={(e) => setDraft({ ...draft, design: e.target.value })} rows={4} />
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">Tasks</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() =>
                setDraft((d) => ({ ...d, tasks: [...d.tasks, { key: `task-${d.tasks.length + 1}`, title: "", description: "", area: "shared", dependsOn: [], files: [] }] }))
              }
            >
              <Plus /> Add task
            </Button>
          </div>
          {draft.tasks.map((t, i) => (
            <div key={i} className="space-y-2 rounded-lg border p-3">
              <div className="flex gap-2">
                <Input value={t.title} onChange={(e) => setTask(i, { title: e.target.value })} placeholder="Title" aria-label={`Task ${i + 1} title`} />
                <Select value={t.area} onChange={(e) => setTask(i, { area: e.target.value as TaskArea })} className="w-32" aria-label={`Task ${i + 1} area`}>
                  {AREAS.map((a) => (
                    <option key={a}>{a}</option>
                  ))}
                </Select>
                <Button variant="ghost" size="icon" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                  <ArrowUp />
                </Button>
                <Button variant="ghost" size="icon" disabled={i === draft.tasks.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                  <ArrowDown />
                </Button>
                <Button variant="ghost" size="icon" onClick={() => setDraft((d) => ({ ...d, tasks: d.tasks.filter((_, j) => j !== i) }))} aria-label="Remove task">
                  <Trash2 />
                </Button>
              </div>
              <Textarea value={t.description} onChange={(e) => setTask(i, { description: e.target.value })} rows={2} placeholder="What to build" />
              <div className="grid grid-cols-2 gap-2">
                <Input value={t.dependsOn.join(", ")} onChange={(e) => setTask(i, { dependsOn: list(e.target.value) })} placeholder="Depends on (task keys)" className="font-mono text-xs" />
                <Input value={t.files.join(", ")} onChange={(e) => setTask(i, { files: list(e.target.value) })} placeholder="Owns files (globs)" className="font-mono text-xs" />
              </div>
              <p className="font-mono text-[11px] text-muted-foreground">key: {t.key}</p>
            </div>
          ))}
        </div>
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            onClick={() => {
              setDraft(plan);
              setEditing(false);
            }}
          >
            Cancel
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              void act(async () => {
                await StoryApi.update(story.id, { plan: draft });
                setEditing(false);
                toast("Plan saved", "success");
              })
            }
          >
            Save plan
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6" data-testid="plan-review">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Badge>plan v{plan.version}</Badge>
        {plan.edited && <Badge>edited by you</Badge>}
        <span>{plan.tasks.length} task(s)</span>
      </div>
      <p className="text-[14px]">{plan.summary}</p>

      {plan.questions.length > 0 && (
        <div className="rounded-lg border border-warning/40 px-4 py-3">
          <div className="mb-1 text-xs font-medium text-warning">The planner has questions</div>
          <ul className="list-disc space-y-0.5 pl-5 text-[13px]">
            {plan.questions.map((q) => (
              <li key={q}>{q}</li>
            ))}
          </ul>
          {!readOnly && (
            <button type="button" className="mt-2 text-xs text-muted-foreground underline" onClick={() => {
              setFeedback(plan.questions.map((q) => `${q}\n→ `).join("\n\n"));
              setRevising(true);
            }}>
              Answer them
            </button>
          )}
        </div>
      )}

      <div>
        <div className="mb-2 text-xs font-medium text-muted-foreground">Tasks</div>
        <ol className="space-y-2">
          {plan.tasks.map((t, i) => (
            <li key={t.key} className="flex gap-3 rounded-lg border px-3 py-2.5">
              <span className="mt-0.5 font-mono text-xs text-muted-foreground">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2 text-[13px] font-medium">
                  {t.title}
                  <Badge>{t.area}</Badge>
                  {t.dependsOn.length > 0 && <span className="text-xs font-normal text-muted-foreground">after {t.dependsOn.join(", ")}</span>}
                </div>
                <p className="mt-0.5 text-xs whitespace-pre-wrap text-muted-foreground">{t.description}</p>
                {t.files.length > 0 && <p className="mt-1 font-mono text-[11px] text-muted-foreground">{t.files.join("  ")}</p>}
              </div>
            </li>
          ))}
        </ol>
      </div>

      <details className="group rounded-lg border px-4 py-3" open>
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Spec</summary>
        <Markdown className="mt-3">{plan.spec}</Markdown>
      </details>
      {plan.design && (
        <details className="rounded-lg border px-4 py-3" open>
          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">Design</summary>
          <Markdown className="mt-3">{plan.design}</Markdown>
        </details>
      )}

      {!readOnly && (
        <>
          {revising && (
            <div className="space-y-2">
              <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} rows={4} placeholder="What should change? Answers to the questions?" aria-label="Plan feedback" autoFocus />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onClick={() => setRevising(false)}>
                  Cancel
                </Button>
                <Button disabled={busy || !feedback.trim()} onClick={() => void act(() => StoryApi.plan(story.id, feedback))}>
                  Send to planner
                </Button>
              </div>
            </div>
          )}
          <ErrorNote error={error} />
          <div className="flex flex-wrap justify-end gap-2 border-t pt-4">
            <Button variant="ghost" onClick={() => setEditing(true)}>
              <Pencil /> Edit plan
            </Button>
            {!revising && (
              <Button variant="outline" onClick={() => setRevising(true)}>
                <MessageSquare /> Revise with feedback
              </Button>
            )}
            <Button onClick={() => setChoosing(true)} disabled={busy}>
              <Check /> Approve &amp; build…
            </Button>
          </div>
          <ModeChooser
            open={choosing}
            plan={plan}
            project={project}
            onClose={() => setChoosing(false)}
            onChoose={(mode, repo) =>
              void act(async () => {
                const run = await StoryApi.approve(story.id, mode, repo);
                setChoosing(false);
                toast(`Building "${story.title}" with ${mode}`, "success");
                if (mode === "single") navigate({ page: "run", id: run.id });
              })
            }
          />
        </>
      )}
    </div>
  );
}
