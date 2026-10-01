import { Settings2, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "@appforge/core";
import { PageHeader } from "@/components/Layout.tsx";
import { ProjectSettingsForm, type ProviderOption } from "@/components/ProjectSettingsForm.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent } from "@/components/ui/card.tsx";
import { ErrorNote, Tabs } from "@/components/ui/misc.tsx";
import { Api } from "@/lib/api.ts";
import { navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";

const FALLBACK_PROVIDERS: ProviderOption[] = [
  { id: "claude-code", label: "Claude Code (subscription)", models: [] },
  { id: "codex-cli", label: "Codex CLI (ChatGPT)", models: [] },
  { id: "claude-api", label: "Claude API (key)", models: [] },
  { id: "openai-api", label: "OpenAI API (key)", models: [] },
];

export function ProjectPage({ id }: { id: string }) {
  const [project, setProject] = useState<Project>();
  const [error, setError] = useState<string>();
  const [tab, setTab] = useState<"runs" | "settings">("settings");

  useEffect(() => {
    Api.project(id).then(setProject, (e: Error) => setError(e.message));
  }, [id]);
  useServerMessages((msg) => {
    if (msg.kind === "project-updated" && msg.project.id === id) setProject(msg.project);
  });

  if (error) return <div className="p-6"><ErrorNote error={error} /></div>;
  if (!project) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;

  const remove = async () => {
    if (!confirm(`Forget "${project.name}"? Files in ${project.path} are not touched.`)) return;
    try {
      await Api.deleteProject(project.id);
      navigate({ page: "projects" });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <div className="mx-auto max-w-6xl p-6">
      <PageHeader
        title={project.name}
        description={
          <div className="flex flex-wrap items-center gap-2">
            <code className="text-xs">{project.path}</code>
            <Badge>{project.stackId}</Badge>
            <Badge>{project.shape === "monorepo" ? "monorepo" : "backend + frontend repos"}</Badge>
          </div>
        }
        actions={
          <Button variant="ghost" size="icon" onClick={() => void remove()} aria-label="Forget project">
            <Trash2 />
          </Button>
        }
      />
      <div className="mb-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            { value: "runs", label: "Runs" },
            { value: "settings", label: <span className="inline-flex items-center gap-1"><Settings2 className="size-3.5" /> Settings</span> },
          ]}
        />
      </div>
      <Card>
        <CardContent className="p-5">
          {tab === "settings" ? (
            <ProjectSettingsForm
              project={project}
              providers={FALLBACK_PROVIDERS}
              onSave={async (settings) => setProject(await Api.updateProject(project.id, { settings }))}
            />
          ) : (
            <p className="text-sm text-muted-foreground">Runs arrive with the orchestrator.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
