import { useEffect, useState } from "react";

export const PROJECT_TABS = ["stories", "runs", "logs", "memory", "preview", "settings"] as const;
export type ProjectTab = (typeof PROJECT_TABS)[number];

/** Hash router: #/, #/projects/:id[/:tab[/:item]], #/runs/:id, #/skills, #/settings. */
export type Route =
  | { page: "home" }
  | { page: "project"; id: string; tab: ProjectTab; item?: string }
  | { page: "run"; id: string }
  | { page: "skills" }
  | { page: "settings"; section?: string };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  if (parts[0] === "projects" && parts[1]) {
    const tab = (PROJECT_TABS as readonly string[]).includes(parts[2] ?? "") ? (parts[2] as ProjectTab) : "stories";
    return { page: "project", id: parts[1], tab, ...(parts[3] ? { item: parts[3] } : {}) };
  }
  if (parts[0] === "runs" && parts[1]) return { page: "run", id: parts[1] };
  if (parts[0] === "skills") return { page: "skills" };
  if (parts[0] === "settings" || parts[0] === "providers") return { page: "settings", ...(parts[1] ? { section: parts[1] } : {}) };
  return { page: "home" };
}

export function href(route: Route): string {
  switch (route.page) {
    case "home":
      return "#/";
    case "project":
      return `#/projects/${encodeURIComponent(route.id)}/${route.tab}${route.item ? `/${encodeURIComponent(route.item)}` : ""}`;
    case "run":
      return `#/runs/${encodeURIComponent(route.id)}`;
    case "skills":
      return "#/skills";
    case "settings":
      return `#/settings${route.section ? `/${route.section}` : ""}`;
  }
}

export function navigate(route: Route): void {
  window.location.hash = href(route);
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parseHash(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseHash(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}
