import { Command, Hammer, Monitor, Moon, OctagonX, Plus, Settings, Sparkles, Sun } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import type { Project } from "@appforge/core";
import { Api, RunApi } from "@/lib/api.ts";
import { href, navigate, type Route } from "@/lib/router.ts";
import { useServerMessages, useSocketStatus } from "@/lib/socket.ts";
import type { ThemeChoice } from "@/lib/theme.ts";
import { cn } from "@/lib/utils.ts";
import { NewProjectDialog } from "@/pages/NewProjectDialog.tsx";
import { CommandPalette } from "./CommandPalette.tsx";
import { Kbd } from "./ui/misc.tsx";
import { toast } from "./ui/toast.tsx";

export function Layout({ route, theme, setTheme, children }: { route: Route; theme: ThemeChoice; setTheme: (t: ThemeChoice) => void; children: ReactNode }) {
  const connected = useSocketStatus();
  const [projects, setProjects] = useState<Project[]>([]);
  const [creating, setCreating] = useState(false);
  const [palette, setPalette] = useState(false);

  useEffect(() => {
    Api.projects().then(setProjects, () => undefined);
  }, []);
  useServerMessages((msg) => {
    if (msg.kind === "project-updated") setProjects((list) => [msg.project, ...list.filter((p) => p.id !== msg.project.id)]);
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPalette((p) => !p);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const kill = async () => {
    if (!confirm("Stop every running agent, test runner, preview and dev server?")) return;
    try {
      const res = await RunApi.kill();
      toast(`Stopped ${res.runs} run(s) and ${res.processes} process(es)`, "success");
    } catch (err) {
      toast((err as Error).message, "error");
    }
  };

  const activeProject = route.page === "project" ? route.id : undefined;
  const nav = (active: boolean) =>
    cn("flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted text-foreground");

  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r px-3 py-4">
        <a href="#/" className="mb-4 flex items-center gap-2 px-2 text-[14px] font-semibold tracking-tight">
          <span className="grid size-6 place-items-center rounded-md bg-foreground text-background">
            <Hammer className="size-3.5" />
          </span>
          AppForge
        </a>
        <button
          type="button"
          onClick={() => setPalette(true)}
          className="mb-4 flex items-center justify-between rounded-md border px-2 py-1.5 text-[13px] text-muted-foreground hover:bg-muted"
        >
          <span className="flex items-center gap-2">
            <Command className="size-3.5" /> Search
          </span>
          <Kbd>⌘K</Kbd>
        </button>

        <div className="mb-1 flex items-center justify-between px-2 text-[11px] font-medium tracking-wide text-muted-foreground uppercase">
          Projects
          <button type="button" className="rounded p-0.5 hover:bg-muted hover:text-foreground" onClick={() => setCreating(true)} aria-label="New project">
            <Plus className="size-3.5" />
          </button>
        </div>
        <nav className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto">
          {projects.map((p) => (
            <a key={p.id} href={href({ page: "project", id: p.id, tab: "stories" })} className={nav(activeProject === p.id)}>
              <span className="truncate">{p.name}</span>
            </a>
          ))}
          {projects.length === 0 && (
            <button type="button" className={nav(false)} onClick={() => setCreating(true)}>
              <Plus className="size-3.5" /> New project
            </button>
          )}
        </nav>

        <div className="mt-3 flex flex-col gap-0.5 border-t pt-3">
          <a href={href({ page: "skills" })} className={nav(route.page === "skills")}>
            <Sparkles className="size-3.5" /> Skills
          </a>
          <a href={href({ page: "settings" })} className={nav(route.page === "settings")}>
            <Settings className="size-3.5" /> Settings
          </a>
          <button type="button" onClick={() => void kill()} className={cn(nav(false), "text-destructive hover:text-destructive")}>
            <OctagonX className="size-3.5" /> Kill switch
          </button>
        </div>
        <div className="mt-3 flex items-center justify-between px-2">
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={connected ? "Connected" : "Reconnecting"}>
            <span className={cn("size-1.5 rounded-full", connected ? "bg-success" : "bg-destructive animate-pulse")} />
            {connected ? "Live" : "Offline"}
          </span>
          <div className="flex rounded-md border p-0.5" role="radiogroup" aria-label="Theme">
            {(
              [
                ["light", Sun],
                ["system", Monitor],
                ["dark", Moon],
              ] as const
            ).map(([value, Icon]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={theme === value}
                aria-label={`${value} theme`}
                onClick={() => setTheme(value)}
                className={cn("rounded p-1 text-muted-foreground", theme === value && "bg-muted text-foreground")}
              >
                <Icon className="size-3" />
              </button>
            ))}
          </div>
        </div>
      </aside>
      <main className="min-w-0 flex-1 overflow-y-auto">{children}</main>
      <NewProjectDialog
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(p) => {
          setCreating(false);
          navigate({ page: "project", id: p.id, tab: "stories" });
        }}
      />
      <CommandPalette
        open={palette}
        onClose={() => setPalette(false)}
        projects={projects}
        route={route}
        onNewProject={() => setCreating(true)}
        onKill={() => void kill()}
        setTheme={setTheme}
        theme={theme}
      />
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="truncate text-xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-[13px] text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Page({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return <div className={cn("mx-auto px-8 py-8", wide ? "max-w-[1400px]" : "max-w-5xl")}>{children}</div>;
}
