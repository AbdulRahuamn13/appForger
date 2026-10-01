import { Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "@appforge/core";
import { Page } from "@/components/Layout.tsx";
import { LogsTab } from "@/components/project/LogsTab.tsx";
import { MemoryTab } from "@/components/project/MemoryTab.tsx";
import { PreviewTab } from "@/components/project/PreviewTab.tsx";
import { SettingsTab } from "@/components/project/SettingsTab.tsx";
import { RunsPanel } from "@/components/RunsPanel.tsx";
import { StoriesTab } from "@/components/stories/StoriesTab.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ErrorNote, Tabs } from "@/components/ui/misc.tsx";
import { Api } from "@/lib/api.ts";
import { navigate, type ProjectTab } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";

const TAB_LABELS: Record<ProjectTab, string> = {
  stories: "Stories",
  runs: "Runs",
  logs: "Logs",
  memory: "Memory",
  preview: "Preview",
  settings: "Settings",
};

export function ProjectPage({ id, tab, item }: { id: string; tab: ProjectTab; item: string | undefined }) {
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    Api.project(id).then(setProject, (e: Error) => setError(e.message));
  }, [id]);
  useServerMessages((msg) => {
    if (msg.kind === "project-updated" && msg.project.id === id) setProject(msg.project);
  });

  if (error) return <Page><ErrorNote error={error} /></Page>;
  if (!project) return null;

  const remove = async () => {
    if (!confirm(`Forget "${project.name}"? Files in ${project.path} are not touched.`)) return;
    try {
      await Api.deleteProject(project.id);
      navigate({ page: "home" });
      window.location.reload();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Page wide>
      <div className="mb-6 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight">{project.name}</h1>
          <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
            {project.path} · {project.stackId} · {project.shape === "monorepo" ? "monorepo" : "2 repos"}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => void remove()} aria-label="Forget project">
          <Trash2 />
        </Button>
      </div>
      <Tabs
        className="mb-6"
        value={tab}
        onChange={(t) => navigate({ page: "project", id, tab: t })}
        tabs={(Object.keys(TAB_LABELS) as ProjectTab[]).map((t) => ({ value: t, label: TAB_LABELS[t] }))}
      />
      {tab === "stories" && <StoriesTab project={project} item={item} />}
      {tab === "runs" && <RunsPanel project={project} />}
      {tab === "logs" && <LogsTab project={project} item={item} />}
      {tab === "memory" && <MemoryTab project={project} />}
      {tab === "preview" && <PreviewTab project={project} />}
      {tab === "settings" && <SettingsTab project={project} onChange={setProject} />}
    </Page>
  );
}
