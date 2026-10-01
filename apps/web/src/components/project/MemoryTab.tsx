import { Eye, Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "@appforge/core";
import { KnowledgeApi } from "@/lib/api.ts";
import { Button } from "../ui/button.tsx";
import { Textarea } from "../ui/input.tsx";
import { Markdown } from "../ui/markdown.tsx";
import { Empty, ErrorNote } from "../ui/misc.tsx";
import { toast } from "../ui/toast.tsx";

/** Project memory: decisions, conventions and gotchas every agent reads. AppForge appends story outcomes. */
export function MemoryTab({ project }: { project: Project }) {
  const [text, setText] = useState<string>();
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    KnowledgeApi.memory(project.id).then(
      (m) => {
        setText(m.text);
        setDraft(m.text);
      },
      (e: Error) => setError(e.message),
    );
  }, [project.id]);

  const save = async () => {
    try {
      await KnowledgeApi.setMemory(project.id, draft);
      setText(draft);
      setEditing(false);
      toast("Memory saved", "success");
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="max-w-3xl space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-[13px] text-muted-foreground">
          What every agent should remember about this project: decisions, conventions, things to avoid. AppForge adds a note after each story; edit freely.
        </p>
        {editing ? (
          <div className="flex shrink-0 gap-2">
            <Button variant="ghost" onClick={() => setEditing(false)}>
              <Eye /> Cancel
            </Button>
            <Button onClick={() => void save()}>Save</Button>
          </div>
        ) : (
          <Button variant="outline" onClick={() => setEditing(true)}>
            <Pencil /> Edit
          </Button>
        )}
      </div>
      <ErrorNote error={error} />
      {editing ? (
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={24}
          className="font-mono text-xs"
          placeholder={"# Project memory\n\n- We use Zod for all request validation\n- Dates are stored in UTC\n- Never add a new UI library; use the existing components"}
          aria-label="Project memory"
        />
      ) : text?.trim() ? (
        <Markdown>{text}</Markdown>
      ) : (
        <Empty>Nothing remembered yet.</Empty>
      )}
    </div>
  );
}
