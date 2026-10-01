import { useEffect, useState } from "react";

/** Tiny hash router: #/, #/projects/:id, #/runs/:id, #/providers. */
export type Route =
  | { page: "projects" }
  | { page: "project"; id: string }
  | { page: "run"; id: string }
  | { page: "providers" };

export function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "projects" && parts[1]) return { page: "project", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "runs" && parts[1]) return { page: "run", id: decodeURIComponent(parts[1]) };
  if (parts[0] === "providers") return { page: "providers" };
  return { page: "projects" };
}

export function href(route: Route): string {
  switch (route.page) {
    case "projects":
      return "#/";
    case "project":
      return `#/projects/${encodeURIComponent(route.id)}`;
    case "run":
      return `#/runs/${encodeURIComponent(route.id)}`;
    case "providers":
      return "#/providers";
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
