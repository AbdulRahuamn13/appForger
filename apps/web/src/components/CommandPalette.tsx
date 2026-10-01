import { ArrowRight, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Project } from "@appforge/core";
import { navigate, PROJECT_TABS, type Route } from "@/lib/router.ts";
import type { ThemeChoice } from "@/lib/theme.ts";
import { cn } from "@/lib/utils.ts";

interface Item {
  label: string;
  hint?: string;
  run: () => void;
}

/** ⌘K: jump anywhere or run an action without leaving the keyboard. */
export function CommandPalette({
  open,
  onClose,
  projects,
  route,
  onNewProject,
  onKill,
  theme,
  setTheme,
}: {
  open: boolean;
  onClose: () => void;
  projects: Project[];
  route: Route;
  onNewProject: () => void;
  onKill: () => void;
  theme: ThemeChoice;
  setTheme: (t: ThemeChoice) => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setIndex(0);
      setTimeout(() => input.current?.focus(), 0);
    }
  }, [open]);

  const items = useMemo<Item[]>(() => {
    const list: Item[] = [];
    const current = route.page === "project" ? projects.find((p) => p.id === route.id) : undefined;
    if (current) {
      list.push({ label: `New story in ${current.name}`, hint: "Story", run: () => navigate({ page: "project", id: current.id, tab: "stories", item: "new" }) });
      for (const tab of PROJECT_TABS) list.push({ label: `${current.name}: ${tab[0]?.toUpperCase()}${tab.slice(1)}`, hint: "Go to", run: () => navigate({ page: "project", id: current.id, tab }) });
    }
    for (const p of projects) list.push({ label: p.name, hint: "Project", run: () => navigate({ page: "project", id: p.id, tab: "stories" }) });
    list.push(
      { label: "New project", hint: "Action", run: onNewProject },
      { label: "Skills", hint: "Go to", run: () => navigate({ page: "skills" }) },
      { label: "Settings", hint: "Go to", run: () => navigate({ page: "settings" }) },
      { label: "Providers and API keys", hint: "Go to", run: () => navigate({ page: "settings", section: "providers" }) },
      { label: "Environment check", hint: "Go to", run: () => navigate({ page: "settings", section: "doctor" }) },
      { label: `Theme: ${theme === "dark" ? "light" : "dark"}`, hint: "Action", run: () => setTheme(theme === "dark" ? "light" : "dark") },
      { label: "Kill switch: stop everything", hint: "Action", run: onKill },
    );
    const q = query.trim().toLowerCase();
    return q ? list.filter((i) => `${i.label} ${i.hint ?? ""}`.toLowerCase().includes(q)) : list;
  }, [projects, route, query, theme, onNewProject, onKill, setTheme]);

  if (!open) return null;
  const choose = (item: Item | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-[var(--overlay)] p-4 pt-[15vh]" onMouseDown={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-xl border bg-card shadow-2xl" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 text-muted-foreground" />
          <input
            ref={input}
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setIndex(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setIndex((i) => Math.min(i + 1, items.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setIndex((i) => Math.max(i - 1, 0));
              } else if (e.key === "Enter") choose(items[index]);
              else if (e.key === "Escape") onClose();
            }}
            placeholder="Go to a project, page or action…"
            className="h-11 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            aria-label="Command"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto p-1">
          {items.map((item, i) => (
            <li key={`${item.label}-${i}`}>
              <button
                type="button"
                onMouseEnter={() => setIndex(i)}
                onClick={() => choose(item)}
                className={cn("flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-[13px]", i === index && "bg-muted")}
              >
                <span>{item.label}</span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  {item.hint} <ArrowRight className="size-3" />
                </span>
              </button>
            </li>
          ))}
          {items.length === 0 && <li className="px-3 py-6 text-center text-[13px] text-muted-foreground">Nothing matches</li>}
        </ul>
      </div>
    </div>
  );
}
