import type { Asset, DoctorCheckDto, ExecutionModeDto, LogFileInfo, PreviewState, RoleId, Skill, StorageSettings, Story, StoryPlan } from "./api-types.ts";
import type {
  AgentEvent,
  Approval,
  FileDiff,
  Project,
  ProjectSettings,
  ProjectShape,
  Run,
  RunLogEvent,
  RunMode,
  Task,
  UnitFramework,
  UsageSummary,
} from "@appforge/core";

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
    api<Project & { scaffolded?: string[] }>(`/api/projects/${id}`, { method: "PATCH", body }),
  writeCi: (id: string) => api<{ written: string[] }>(`/api/projects/${id}/ci`, { method: "POST", body: {} }),
  deleteProject: (id: string) => api<{ ok: true }>(`/api/projects/${id}`, { method: "DELETE" }),
  scaffold: (id: string) => api<{ written: string[] }>(`/api/projects/${id}/scaffold`, { method: "POST", body: {} }),
};

export interface ProviderInfo {
  id: string;
  label: string;
  vendor: string;
  authKind: "subscription" | "api-key";
  models: string[];
  defaultModel?: string;
  status?: { ok: boolean; installed: boolean; detail: string; hint?: string };
}

export interface SecretStatus {
  present: boolean;
  source?: "keychain" | "env";
  keychainError?: string;
}

export const ProviderApi = {
  list: (refresh = false) => api<ProviderInfo[]>(`/api/providers${refresh ? "?refresh=1" : ""}`),
  secrets: () => api<Record<string, SecretStatus>>("/api/secrets"),
  setSecret: (name: string, value: string) => api<{ ok: true }>(`/api/secrets/${name}`, { method: "PUT", body: { value } }),
  deleteSecret: (name: string) => api<{ ok: true }>(`/api/secrets/${name}`, { method: "DELETE" }),
  playground: (body: { provider: string; model?: string; prompt: string; projectId?: string }) =>
    api<{ id: string; cwd: string }>("/api/playground", { body }),
  stopPlayground: (id: string) => api<{ ok: true }>(`/api/playground/${id}/stop`, { method: "POST", body: {} }),
};


export interface RunDetail {
  run: Run;
  project: Project;
  tasks: Task[];
  approvals: Approval[];
  logs: RunLogEvent[];
  active: boolean;
}

export const RunApi = {
  list: (projectId: string) => api<Run[]>(`/api/projects/${projectId}/runs`),
  create: (projectId: string, body: { mode: RunMode; brief: string; repo?: string }) => api<Run>(`/api/projects/${projectId}/runs`, { body }),
  get: (runId: string) => api<RunDetail>(`/api/runs/${runId}`),
  events: (runId: string, after = 0) => api<{ seq: number; event: AgentEvent }[]>(`/api/runs/${runId}/events?after=${after}`),
  usage: (runId: string) => api<UsageSummary[]>(`/api/runs/${runId}/usage`),
  stop: (runId: string) => api<{ stopped: boolean }>(`/api/runs/${runId}/stop`, { body: {} }),
  resume: (runId: string) => api<Run>(`/api/runs/${runId}/resume`, { body: {} }),
  message: (runId: string, text: string) => api<{ ok: true }>(`/api/runs/${runId}/message`, { body: { text } }),
  finish: (runId: string) => api<{ ok: true }>(`/api/runs/${runId}/finish`, { body: {} }),
  discard: (runId: string) => api<{ ok: true }>(`/api/runs/${runId}/discard`, { body: {} }),
  decide: (approvalId: string, approved: boolean, comment?: string) =>
    api<Approval>(`/api/approvals/${approvalId}`, { body: { approved, ...(comment ? { comment } : {}) } }),
  approvalDiff: (approvalId: string) => api<FileDiff[]>(`/api/approvals/${approvalId}/diff`),
  taskDiff: (taskId: string) => api<FileDiff[]>(`/api/tasks/${taskId}/diff`),
  kill: () => api<{ runs: number; processes: number }>("/api/kill", { body: {} }),
};

// ───── Stories, logs, memory, images, skills, settings ─────


export interface StoryInput {
  title?: string;
  body?: string;
  acceptance?: string;
  images?: string[];
}

export const StoryApi = {
  list: (projectId: string) => api<Story[]>(`/api/projects/${projectId}/stories`),
  get: (id: string) => api<{ story: Story; runs: Run[] }>(`/api/stories/${id}`),
  create: (projectId: string, body: StoryInput) => api<Story>(`/api/projects/${projectId}/stories`, { body }),
  update: (id: string, body: StoryInput & { plan?: StoryPlan }) => api<Story>(`/api/stories/${id}`, { method: "PATCH", body }),
  remove: (id: string) => api<{ ok: true }>(`/api/stories/${id}`, { method: "DELETE" }),
  reorder: (projectId: string, ids: string[]) => api<Story[]>(`/api/projects/${projectId}/stories/reorder`, { body: { ids } }),
  plan: (id: string, feedback?: string) => api<Run>(`/api/stories/${id}/plan`, { body: feedback ? { feedback } : {} }),
  approve: (id: string, mode: ExecutionModeDto, repo?: string) => api<Run>(`/api/stories/${id}/approve`, { body: { mode, ...(repo ? { repo } : {}) } }),
  undo: (id: string) => api<{ reverted: number }>(`/api/stories/${id}/undo`, { body: {} }),
};

export const KnowledgeApi = {
  logs: (projectId: string) => api<LogFileInfo[]>(`/api/projects/${projectId}/logs`),
  log: async (projectId: string, name: string) => {
    const res = await fetch(`/api/projects/${projectId}/logs/${encodeURIComponent(name)}`);
    if (!res.ok) throw new ApiError("Log not found", res.status);
    return res.text();
  },
  logUrl: (projectId: string, name: string) => `/api/projects/${projectId}/logs/${encodeURIComponent(name)}?download=1`,
  allLogsUrl: (projectId: string) => `/api/projects/${projectId}/logs-all`,
  saveRunLog: (runId: string) => api<{ name: string }>(`/api/runs/${runId}/log`, { body: {} }),
  memory: (projectId: string) => api<{ text: string }>(`/api/projects/${projectId}/memory`),
  setMemory: (projectId: string, text: string) => api<{ ok: true }>(`/api/projects/${projectId}/memory`, { method: "PUT", body: { text } }),
  uploadImage: async (projectId: string, file: File) => {
    const buf = new Uint8Array(await file.arrayBuffer());
    let binary = "";
    for (let i = 0; i < buf.length; i += 0x8000) binary += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return api<Asset>(`/api/projects/${projectId}/assets`, { body: { name: file.name || "pasted.png", mediaType: file.type, dataBase64: btoa(binary) } });
  },
  imageUrl: (assetId: string) => `/api/assets/${assetId}`,
  skills: () => api<Skill[]>("/api/skills"),
  createSkill: (body: { name: string; description: string; roles: RoleId[]; default: boolean; body: string }) => api<Skill>("/api/skills", { body }),
  saveSkill: (id: string, body: { name: string; description: string; roles: RoleId[]; default: boolean; body: string }) => api<Skill>(`/api/skills/${id}`, { method: "PUT", body }),
  deleteSkill: (id: string) => api<{ ok: true }>(`/api/skills/${id}`, { method: "DELETE" }),
  importSkills: (body: { path?: string; markdown?: string }) => api<{ imported: Skill[] }>("/api/skills/import", { body }),
};

export interface StorageInfo {
  settings: StorageSettings;
  location: string;
  active: "local" | "cloud";
  copied?: number;
  credentials: { accessKeyId: SecretStatus; secretAccessKey: SecretStatus };
}

export const SettingsApi = {
  storage: () => api<StorageInfo>("/api/settings/storage"),
  setStorage: (body: { settings: StorageSettings; credentials?: { accessKeyId?: string; secretAccessKey?: string }; copy: boolean }) =>
    api<StorageInfo>("/api/settings/storage", { method: "PUT", body }),
  doctor: () => api<DoctorCheckDto[]>("/api/doctor"),
  preview: (projectId: string) => api<PreviewState>(`/api/projects/${projectId}/preview`),
  startPreview: (projectId: string) => api<PreviewState>(`/api/projects/${projectId}/preview/start`, { body: {} }),
  stopPreview: (projectId: string) => api<PreviewState>(`/api/projects/${projectId}/preview/stop`, { body: {} }),
};
