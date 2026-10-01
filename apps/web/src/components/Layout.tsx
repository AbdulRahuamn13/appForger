import { Boxes, Hammer, KeyRound, OctagonX } from "lucide-react";
import { useState, type ReactNode } from "react";
import { RunApi } from "@/lib/api.ts";
import { href, type Route } from "@/lib/router.ts";
import { useSocketStatus } from "@/lib/socket.ts";
import { cn } from "@/lib/utils.ts";

export function Layout({ route, children, headerRight }: { route: Route; children: ReactNode; headerRight?: ReactNode }) {
  const connected = useSocketStatus();
  const nav = [
    { label: "Projects", icon: Boxes, to: href({ page: "projects" }), active: route.page === "projects" || route.page === "project" || route.page === "run" },
    { label: "Providers", icon: KeyRound, to: href({ page: "providers" }), active: route.page === "providers" },
  ];
  return (
    <div className="flex h-full">
      <aside className="flex w-56 shrink-0 flex-col border-r bg-card">
        <a href="#/" className="flex items-center gap-2 px-4 py-4 font-semibold">
          <span className="grid size-7 place-items-center rounded-md bg-primary text-primary-foreground">
            <Hammer className="size-4" />
          </span>
          AppForge
        </a>
        <nav className="flex flex-col gap-0.5 px-2">
          {nav.map((item) => (
            <a
              key={item.label}
              href={item.to}
              className={cn(
                "flex items-center gap-2 rounded-md px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground",
                item.active && "bg-muted font-medium text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {item.label}
            </a>
          ))}
        </nav>
        <KillSwitch />
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted-foreground">
          <span className={cn("size-2 rounded-full", connected ? "bg-success" : "bg-destructive")} />
          {connected ? "Live" : "Reconnecting…"}
        </div>
      </aside>
      <div className="flex min-w-0 flex-1 flex-col">
        {headerRight && <header className="flex h-12 shrink-0 items-center justify-end gap-2 border-b bg-card px-4">{headerRight}</header>}
        <main className="min-h-0 flex-1 overflow-y-auto">{children}</main>
      </div>
    </div>
  );
}

export function PageHeader({ title, description, actions }: { title: ReactNode; description?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <div className="mt-1 text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Global kill switch: stops every run, agent session and child process. */
function KillSwitch() {
  const [note, setNote] = useState<string>();
  const kill = async () => {
    if (!confirm("Stop every running agent, test runner and dev server?")) return;
    try {
      const res = await RunApi.kill();
      setNote(`Stopped ${res.runs} run(s), ${res.processes} process(es)`);
    } catch (err) {
      setNote((err as Error).message);
    }
    setTimeout(() => setNote(undefined), 5_000);
  };
  return (
    <div className="mt-auto px-2">
      <button
        type="button"
        onClick={() => void kill()}
        className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-destructive hover:bg-destructive/10"
      >
        <OctagonX className="size-4" /> Kill switch
      </button>
      {note && <p className="px-3 pb-1 text-xs text-muted-foreground">{note}</p>}
    </div>
  );
}
