import { ArrowDown, ArrowUp, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project, Story } from "@appforge/core";
import { StoryApi } from "@/lib/api.ts";
import { navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { cn } from "@/lib/utils.ts";
import { Badge, isBusy, statusTone } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { Empty } from "../ui/misc.tsx";
import { StoryComposer } from "./StoryComposer.tsx";
import { STORY_LABELS, StoryDetail } from "./StoryDetail.tsx";

/** The project's backlog: add as many stories as you like, then plan → approve → build each one. */
export function StoriesTab({ project, item }: { project: Project; item: string | undefined }) {
  const [stories, setStories] = useState<Story[]>();
  useEffect(() => {
    StoryApi.list(project.id).then(setStories, () => setStories([]));
  }, [project.id]);
  useServerMessages((msg) => {
    if (msg.kind === "story-updated" && msg.story.projectId === project.id)
      setStories((list) => [...(list ?? []).filter((s) => s.id !== msg.story.id), msg.story].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt)));
    if (msg.kind === "story-deleted" && msg.projectId === project.id) setStories((list) => (list ?? []).filter((s) => s.id !== msg.storyId));
  });

  const select = (id?: string) => navigate({ page: "project", id: project.id, tab: "stories", ...(id ? { item: id } : {}) });
  const selected = stories?.find((s) => s.id === item) ?? (item === "new" ? undefined : stories?.[0]);
  const composing = item === "new" || (stories !== undefined && stories.length === 0);

  const move = async (index: number, dir: -1 | 1) => {
    if (!stories) return;
    const ids = stories.map((s) => s.id);
    const [id] = ids.splice(index, 1);
    if (!id) return;
    ids.splice(index + dir, 0, id);
    setStories(await StoryApi.reorder(project.id, ids));
  };

  const counts = { open: stories?.filter((s) => !["done", "reverted"].includes(s.status)).length ?? 0, done: stories?.filter((s) => s.status === "done").length ?? 0 };

  return (
    <div className="grid min-h-[60vh] grid-cols-[17rem_1fr] gap-8">
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {counts.open} open · {counts.done} done
          </span>
          <Button size="sm" onClick={() => select("new")}>
            <Plus /> New story
          </Button>
        </div>
        <ul className="space-y-1" data-testid="story-list">
          {stories?.map((s, i) => (
            <li key={s.id} className="group relative">
              <button
                type="button"
                onClick={() => select(s.id)}
                className={cn("w-full rounded-md px-3 py-2 text-left hover:bg-muted", !composing && selected?.id === s.id && "bg-muted")}
              >
                <div className="truncate pr-10 text-[13px] font-medium">{s.title}</div>
                <div className="mt-1 flex items-center gap-2">
                  <Badge tone={statusTone(s.status)} dot pulse={isBusy(s.status)} className="border-0 px-0">
                    {STORY_LABELS[s.status]}
                  </Badge>
                  {s.images.length > 0 && <span className="text-[11px] text-muted-foreground">{s.images.length} image(s)</span>}
                </div>
              </button>
              <div className="absolute top-2 right-1 hidden gap-0.5 group-hover:flex">
                <button type="button" aria-label="Move up" disabled={i === 0} className="rounded p-0.5 text-muted-foreground hover:bg-background disabled:opacity-30" onClick={() => void move(i, -1)}>
                  <ArrowUp className="size-3" />
                </button>
                <button
                  type="button"
                  aria-label="Move down"
                  disabled={i === (stories?.length ?? 0) - 1}
                  className="rounded p-0.5 text-muted-foreground hover:bg-background disabled:opacity-30"
                  onClick={() => void move(i, 1)}
                >
                  <ArrowDown className="size-3" />
                </button>
              </div>
            </li>
          ))}
        </ul>
        {stories?.length === 0 && <p className="px-3 text-xs text-muted-foreground">No stories yet.</p>}
      </div>
      <div className="min-w-0">
        {composing ? (
          <StoryComposer projectId={project.id} onCreated={(s) => select(s.id)} onCancel={() => select(stories?.[0]?.id)} />
        ) : selected ? (
          <StoryDetail key={selected.id} story={selected} project={project} onDeleted={() => select()} />
        ) : (
          stories && <Empty>Pick a story or create one.</Empty>
        )}
      </div>
    </div>
  );
}
