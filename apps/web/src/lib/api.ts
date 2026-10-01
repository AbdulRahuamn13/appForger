import type { Project, ProjectSettings, ProjectShape, UnitFramework } from "@appforge/core";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: init.method ?? (init.body === undefined ? "GET" : "POST"),
    headers: init.body === undefined ? {} : { "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : undefined;
  if (!res.ok) {
    const message = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : res.statusText;
    throw new ApiError(message, res.status);
  }
  return data as T;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: { name: string; path: string; isGitRepo: boolean }[];
  shortcuts: { label: string; path: string }[];
}

export interface StackInfo {
  id: string;
  label: string;
  description: string;
  backend: { id: string; label: string; unitFrameworks: UnitFramework[]; defaultUnit: UnitFramework };
  frontend: { id: string; label: string; unitFrameworks: UnitFramework[]; defaultUnit: UnitFramework };
}

export interface CreateProjectBody {
  name: string;
  path: string;
  shape: ProjectShape;
  stackId: string;
  scaffold: boolean;
  settings?: Partial<ProjectSettings>;
}

export const Api = {
  listDir: (path?: string) => api<DirListing>(`/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  mkdir: (parent: string, name: string) => api<{ path: string }>("/api/fs/mkdir", { body: { parent, name } }),
  stacks: () => api<StackInfo[]>("/api/stacks"),
  projects: () => api<Project[]>("/api/projects"),
  project: (id: string) => api<Project>(`/api/projects/${id}`),
  createProject: (body: CreateProjectBody) => api<Project>("/api/projects", { body }),
  updateProject: (id: string, body: { name?: string; settings?: Partial<ProjectSettings> }) =>
    api<Project>(`/api/projects/${id}`, { method: "PATCH", body }),
  deleteProject: (id: string) => api<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  scaffold: (id: string) => api<{ written: string[] }>(`/api/projects/${id}/scaffold`, { method: "POST", body: {} }),
};
