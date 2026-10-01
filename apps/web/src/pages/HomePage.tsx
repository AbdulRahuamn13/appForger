import { ArrowRight, FolderGit2, Plus } from "lucide-react";
import { useEffect, useState } from "react";
import type { Project } from "@appforge/core";
import { Page } from "@/components/Layout.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Api, SettingsApi } from "@/lib/api.ts";
import type { DoctorCheckDto } from "@/lib/api-types.ts";
import { href, navigate } from "@/lib/router.ts";
import { useServerMessages } from "@/lib/socket.ts";
import { timeAgo } from "@/lib/utils.ts";
import { NewProjectDialog } from "./NewProjectDialog.tsx";

export function HomePage() {
  const [projects, setProjects] = useState<Project[]>();
  const [creating, setCreating] = useState(false);
  const [doctor, setDoctor] = useState<DoctorCheckDto[]>();

  useEffect(() => {
    Api.projects().then(setProjects, () => setProjects([]));
    SettingsApi.doctor().then(setDoctor, () => undefined);
  }, []);
  useServerMessages((msg) => {
    if (msg.kind === "project-updated") setProjects((list) => [msg.project, ...(list ?? []).filter((p) => p.id !== msg.project.id)]);
  });

  const problems = doctor?.filter((c) => !c.ok && !c.optional) ?? [];

  return (
    <Page>
      <div className="mb-10 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Build something.</h1>
          <p className="mt-1 text-[13px] text-muted-foreground">Write a story, review the plan, approve it, and let the agents build, review and test it in your repo.</p>
        </div>
        <Button onClick={() => setCreating(true)}>
          <Plus /> New project
        </Button>
      </div>

      {problems.length > 0 && (
        <a href={href({ page: "settings", section: "doctor" })} className="mb-8 block rounded-lg border border-warning/40 px-4 py-3 text-[13px] hover:bg-muted">
          <span className="font-medium text-warning">Setup needs attention:</span> {problems.map((p) => p.name).join(", ")} <ArrowRight className="inline size-3" />
        </a>
      )}

      {projects && projects.length === 0 ? (
        <div className="rounded-xl border border-dashed px-8 py-16 text-center">
          <FolderGit2 className="mx-auto mb-3 size-6 text-muted-foreground" />
          <p className="text-[15px] font-medium">No projects yet</p>
          <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">A project is a folder on this machine. AppForge runs git init there and agents only ever work inside it.</p>
          <Button className="mt-5" onClick={() => setCreating(true)}>
            Create your first project
          </Button>
        </div>
      ) : (
        <ul className="divide-y rounded-lg border">
          {projects?.map((p) => (
            <li key={p.id}>
              <a href={href({ page: "project", id: p.id, tab: "stories" })} className="flex items-center gap-4 px-4 py-3.5 hover:bg-muted/60">
                <div className="min-w-0 flex-1">
                  <div className="text-[14px] font-medium">{p.name}</div>
                  <div className="truncate font-mono text-xs text-muted-foreground">{p.path}</div>
                </div>
                <span className="text-xs text-muted-foreground">{p.stackId}</span>
                <span className="w-20 text-right text-xs text-muted-foreground">{timeAgo(p.createdAt)}</span>
                <ArrowRight className="size-3.5 text-muted-foreground" />
              </a>
            </li>
          ))}
        </ul>
      )}
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          navigate({ page: "project", id: p.id, tab: "stories" });
        }}
      />
    </Page>
  );
}
