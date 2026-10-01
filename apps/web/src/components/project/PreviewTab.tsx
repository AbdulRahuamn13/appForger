import { ExternalLink, Play, RotateCw, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PreviewState, Project } from "@appforge/core";
import { SettingsApi } from "@/lib/api.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { Badge, statusTone } from "../ui/badge.tsx";
import { Button } from "../ui/button.tsx";
import { ErrorNote, Spinner } from "../ui/misc.tsx";

/** Run the app you're building, right here: backend + frontend dev servers on free ports. */
export function PreviewTab({ project }: { project: Project }) {
  const [state, setState] = useState<PreviewState>({ status: "stopped", output: "" });
  const [error, setError] = useState<string>();
  const [frameKey, setFrameKey] = useState(0);
  const out = useRef<HTMLPreElement>(null);

  useEffect(() => {
    SettingsApi.preview(project.id).then(setState, () => undefined);
  }, [project.id]);
  useServerMessages((msg) => {
    if (msg.kind === "preview-updated" && msg.projectId === project.id) setState(msg.preview);
  });
  useEffect(() => {
    if (out.current) out.current.scrollTop = out.current.scrollHeight;
  }, [state.output]);

  const act = (fn: () => Promise<PreviewState>) =>
    fn().then(setState, (e: Error) => setError(e.message));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Badge tone={statusTone(state.status === "running" ? "running-ok" : state.status)} dot pulse={state.status === "starting"} data-testid="preview-status">
            {state.status}
          </Badge>
          {state.frontendUrl && (
            <a href={state.frontendUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1 font-mono text-xs text-muted-foreground hover:text-foreground">
              {state.frontendUrl} <ExternalLink className="size-3" />
            </a>
          )}
          {state.backendUrl && <span className="font-mono text-xs text-muted-foreground">API {state.backendUrl}</span>}
        </div>
        <div className="flex gap-2">
          {state.status === "running" && (
            <Button variant="ghost" onClick={() => setFrameKey((k) => k + 1)}>
              <RotateCw /> Reload
            </Button>
          )}
          {state.status === "running" || state.status === "starting" ? (
            <Button variant="outline" onClick={() => void act(() => SettingsApi.stopPreview(project.id))}>
              <Square /> Stop
            </Button>
          ) : (
            <Button onClick={() => void act(() => SettingsApi.startPreview(project.id))}>
              <Play /> Start preview
            </Button>
          )}
        </div>
      </div>
      <ErrorNote error={error ?? state.error} />
      {state.status === "stopped" && !state.output && (
        <p className="text-[13px] text-muted-foreground">Installs dependencies if needed, starts the backend and frontend from the main branch, and shows the app here. The first start can take a minute.</p>
      )}
      {state.status === "starting" && (
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Spinner /> Starting servers…
        </p>
      )}
      {state.status === "running" && state.frontendUrl && (
        <iframe key={frameKey} src={state.frontendUrl} title="App preview" className="h-[60vh] w-full rounded-lg border bg-white" data-testid="preview-frame" />
      )}
      {state.output && (
        <details open={state.status !== "running"}>
          <summary className="cursor-pointer text-xs text-muted-foreground">Server output</summary>
          <pre ref={out} className="mt-2 max-h-72 overflow-auto rounded-lg border bg-muted/30 p-3 font-mono text-[11px] whitespace-pre-wrap">
            {state.output}
          </pre>
        </details>
      )}
    </div>
  );
}
