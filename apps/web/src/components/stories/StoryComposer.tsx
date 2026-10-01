import { useState } from "react";
import type { Story } from "@appforge/core";
import { StoryApi } from "@/lib/api.ts";
import { Button } from "../ui/button.tsx";
import { Field, Input, Textarea } from "../ui/input.tsx";
import { ErrorNote } from "../ui/misc.tsx";
import { ImagePicker } from "./ImagePicker.tsx";
import { STORY_TEMPLATES } from "./templates.ts";

/** Write a story: what to build, how you'll know it's done, and optional reference images. */
export function StoryComposer({ projectId, onCreated, onCancel }: { projectId: string; onCreated: (s: Story, planNow: boolean) => void; onCancel: () => void }) {
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [acceptance, setAcceptance] = useState("");
  const [images, setImages] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const save = async (planNow: boolean) => {
    setBusy(true);
    setError(undefined);
    try {
      const story = await StoryApi.create(projectId, { title, body, acceptance, images });
      if (planNow) await StoryApi.plan(story.id);
      onCreated(story, planNow);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-5" data-testid="story-composer">
      <div>
        <h2 className="text-[15px] font-semibold">New story</h2>
        <p className="text-[13px] text-muted-foreground">Describe what you want. A planner proposes a plan first; nothing is built until you approve it.</p>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {STORY_TEMPLATES.map((t) => (
          <button
            key={t.label}
            type="button"
            className="rounded-full border px-2.5 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={() => {
              setTitle(t.title);
              setBody(t.body);
              setAcceptance(t.acceptance);
            }}
          >
            {t.label}
          </button>
        ))}
      </div>
      <Field label="Title">
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Todo list with due dates" aria-label="Story title" autoFocus />
      </Field>
      <Field label="What should be built?">
        <Textarea value={body} onChange={(e) => setBody(e.target.value)} rows={5} placeholder="Who is it for, what can they do, what data is involved…" aria-label="Story description" />
      </Field>
      <Field label="Acceptance criteria" hint="One per line. The reviewer checks each one.">
        <Textarea value={acceptance} onChange={(e) => setAcceptance(e.target.value)} rows={3} placeholder="- Empty titles are rejected" aria-label="Acceptance criteria" />
      </Field>
      <Field label="Reference images" hint="Mockups or screenshots to design from. Click, drop, or paste.">
        <ImagePicker projectId={projectId} value={images} onChange={setImages} />
      </Field>
      <ErrorNote error={error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="outline" disabled={busy || !title.trim()} onClick={() => void save(false)}>
          Save draft
        </Button>
        <Button disabled={busy || !title.trim()} onClick={() => void save(true)}>
          Save &amp; plan
        </Button>
      </div>
    </div>
  );
}
