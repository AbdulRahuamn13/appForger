import { Download, FileText, Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { LogFileInfo, Project } from "@appforge/core";
import { KnowledgeApi } from "@/lib/api.ts";
import { navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { cn, timeAgo } from "@/lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Input } from "../ui/input.tsx";
import { Empty, Spinner } from "../ui/misc.tsx";

function size(bytes: number): string {
  return bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** Every run's log as a text file: browse, search and download. Agents read these too. */
export function LogsTab({ project, item }: { project: Project; item: string | undefined }) {
  const [files, setFiles] = useState<LogFileInfo[]>();
  const [text, setText] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");

  const refresh = () => void KnowledgeApi.logs(project.id).then(setFiles, () => setFiles([]));
  useEffect(refresh, [project.id]);
  useServerMessages((msg) => {
    if (msg.kind === "log-saved" && msg.projectId === project.id) refresh();
  });

  const selected = item ?? files?.[0]?.name;
  useEffect(() => {
    if (!selected) return setText(undefined);
    setLoading(true);
    KnowledgeApi.log(project.id, selected).then(
      (t) => {
        setText(t);
        setLoading(false);
      },
      () => {
        setText("Could not load this log.");
        setLoading(false);
      },
    );
  }, [project.id, selected]);

  const lines = useMemo(() => {
    if (text === undefined) return [];
    const all = text.split("\n");
    const q = query.trim().toLowerCase();
    return q ? all.filter((l) => l.toLowerCase().includes(q)) : all;
  }, [text, query]);

  if (files && files.length === 0) return <Empty icon={<FileText className="size-5" />}>No logs yet. Every plan and build writes one here when it finishes.</Empty>;

  return (
    <div className="grid grid-cols-[17rem_1fr] gap-6">
      <div className="space-y-2">
        <a href={KnowledgeApi.allLogsUrl(project.id)} className="flex items-center gap-1.5 px-2 text-xs text-muted-foreground hover:text-foreground">
          <Download className="size-3" /> Download all as one file
        </a>
        <ul className="space-y-0.5" data-testid="log-list">
          {files?.map((f) => (
            <li key={f.name}>
              <button
                type="button"
                onClick={() => navigate({ page: "project", id: project.id, tab: "logs", item: f.name })}
                className={cn("w-full rounded-md px-2 py-1.5 text-left hover:bg-muted", selected === f.name && "bg-muted")}
              >
                <div className="truncate font-mono text-[11px]">{f.name}</div>
                <div className="text-[11px] text-muted-foreground">
                  {timeAgo(f.updatedAt)} · {size(f.size)}
                </div>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="min-w-0 space-y-2">
        <div className="flex items-center gap-2">
          <div className="relative flex-1">
            <Search className="absolute top-2 left-2.5 size-3.5 text-muted-foreground" />
            <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter lines…" className="pl-8" aria-label="Filter log" />
          </div>
          {selected && (
            <a href={KnowledgeApi.logUrl(project.id, selected)} download>
              <Button variant="outline">
                <Download /> Download .txt
              </Button>
            </a>
          )}
        </div>
        <div className="h-[65vh] overflow-auto rounded-lg border bg-muted/30 p-4" data-testid="log-viewer">
          {loading ? (
            <Spinner />
          ) : (
            <pre className="font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap">{lines.join("\n")}</pre>
          )}
        </div>
        {query && <p className="text-xs text-muted-foreground">{lines.length} matching line(s)</p>}
      </div>
    </div>
  );
}
