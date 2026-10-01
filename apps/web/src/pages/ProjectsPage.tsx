import { FolderGit2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "@appforge/core";
import { PageHeader } from "@/components/Layout.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { Empty, ErrorNote } from "@/components/ui/misc.tsx";
import { Api } from "@/lib/api.ts";
import { href, navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { timeAgo } from "@/lib/utils.ts";
import { NewProjectDialog } from "./NewProjectDialog.tsx";

export function ProjectsPage() {
  const [projects, setProjects] = useState<Project[]>();
  const [error, setError] = useState<string>();
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    Api.projects().then(setProjects, (e: Error) => setError(e.message));
  }, []);

  useServerMessages((msg) => {
    if (msg.kind !== "project-updated") return;
    setProjects((list) => [msg.project, ...(list ?? []).filter((p) => p.id !== msg.project.id)]);
  });

  return (
    <div className="mx-auto max-w-5xl p-6">
      <PageHeader
        title="Projects"
        description="Each project is a folder on this machine. Agents only ever work inside it."
        actions={
          <Button onClick={() => setCreating(true)}>
            <Plus /> New project
          </Button>
        }
      />
      <ErrorNote error={error} />
      {projects && projects.length === 0 && (
        <Empty>
          No projects yet. <button className="font-medium text-primary underline" onClick={() => setCreating(true)}>Create one</button> in a folder you choose.
        </Empty>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {projects?.map((p) => (
          <a key={p.id} href={href({ page: "project", id: p.id })}>
            <Card className="transition-colors hover:border-primary/50">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <FolderGit2 className="size-4 text-primary" /> {p.name}
                </CardTitle>
                <CardDescription className="truncate font-mono text-xs">{p.path}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-1.5">
                <Badge>{p.stackId}</Badge>
                <Badge>{p.shape === "monorepo" ? "monorepo" : "2 repos"}</Badge>
                <Badge>e2e: {p.settings.e2e}</Badge>
                <span className="ml-auto text-xs text-muted-foreground">{timeAgo(p.createdAt)}</span>
              </CardContent>
            </Card>
          </a>
        ))}
      </div>
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          navigate({ page: "project", id: p.id });
        }}
      />
    </div>
  );
}
