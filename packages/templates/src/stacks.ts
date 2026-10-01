import type { ProjectShape, RepoRef, TaskArea, UnitFramework } from "@appforge/core";

export interface DevCommand {
  file: string;
  /** `{port}` is replaced with a free port chosen by the orchestrator. */
  args: string[];
  /** `{port}` and `{backendUrl}` placeholders are replaced too. */
  env: Record<string, string>;
  /** Path polled until the server answers. */
  readyPath: string;
}

export interface StackPart {
  area: Exclude<TaskArea, "shared">;
  id: string;
  label: string;
  language: "typescript" | "python" | "csharp";
  unitFrameworks: UnitFramework[];
  defaultUnit: UnitFramework;
  /** Commands to install dependencies, run in the part's folder. */
  install: { file: string; args: string[] }[];
  dev: DevCommand;
  /** Starter files, relative to the part's folder. */
  files: (ctx: StackContext) => Record<string, string>;
  /** Injected into every agent prompt for this project. */
  conventions: string;
}

export interface StackContext {
  projectName: string;
}

export interface StackTemplate {
  id: string;
  label: string;
  description: string;
  backend: StackPart;
  frontend: StackPart;
}

/** Both parts always live in backend/ and frontend/; the shape decides whether that is one repo or two. */
export const PART_DIRS: Record<StackPart["area"], string> = { backend: "backend", frontend: "frontend" };

export function reposForShape(shape: ProjectShape): RepoRef[] {
  return shape === "monorepo"
    ? [{ path: ".", area: "shared" }]
    : [
        { path: PART_DIRS.backend, area: "backend" },
        { path: PART_DIRS.frontend, area: "frontend" },
      ];
}

/** Repo (relative to the project folder) and folder inside that repo for a part. */
export function locatePart(shape: ProjectShape, area: StackPart["area"]): { repo: string; dirInRepo: string } {
  return shape === "monorepo" ? { repo: ".", dirInRepo: PART_DIRS[area] } : { repo: PART_DIRS[area], dirInRepo: "." };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

const reactVite: StackPart = {
  area: "frontend",
  id: "react-vite",
  label: "React + Vite (TypeScript)",
  language: "typescript",
  unitFrameworks: ["vitest", "jest", "none"],
  defaultUnit: "vitest",
  install: [{ file: "npm", args: ["install"] }],
  dev: {
    file: "npx",
    args: ["vite", "--port", "{port}", "--strictPort", "--host", "127.0.0.1"],
    env: { API_URL: "{backendUrl}" },
    readyPath: "/",
  },
  conventions: [
    "Frontend: React 19 + Vite + TypeScript in frontend/. Components in src/components, API calls in src/api.",
    "The dev server proxies /api to the backend (API_URL env var), so call relative /api/... URLs.",
    "Give interactive elements accessible names or data-testid attributes so E2E tests can find them.",
  ].join("\n"),
  files: ({ projectName }) => ({
    "package.json": json({
      name: `${slug(projectName)}-web`,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "vite", build: "tsc -b && vite build", preview: "vite preview", test: "vitest run" },
      dependencies: { react: "^19.3.0", "react-dom": "^19.3.0" },
      devDependencies: {
        "@types/react": "^19.3.0",
        "@types/react-dom": "^19.3.0",
        "@vitejs/plugin-react": "^6.0.0",
        "@testing-library/react": "^16.3.3",
        jsdom: "^30.1.1",
        typescript: "~6.0.3",
        vite: "^8.3.2",
        vitest: "^5.0.3",
      },
    }),
    "index.html": `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(projectName)}</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
`,
    "vite.config.ts": `import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { "/api": process.env.API_URL ?? "http://127.0.0.1:3000" },
  },
  test: { environment: "jsdom", exclude: ["e2e/**", "cypress/**", "node_modules/**"] },
});
`,
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2022",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        module: "ESNext",
        moduleResolution: "Bundler",
        jsx: "react-jsx",
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        types: ["vite/client"],
      },
      include: ["src"],
    }),
    "src/main.tsx": `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`,
    "src/App.tsx": `import { useEffect, useState } from "react";

export function App() {
  const [status, setStatus] = useState("checking…");
  useEffect(() => {
    fetch("/api/health")
      .then((r) => r.json())
      .then((body: { status: string }) => setStatus(body.status))
      .catch(() => setStatus("backend unreachable"));
  }, []);
  return (
    <main>
      <h1>${escapeHtml(projectName)}</h1>
      <p data-testid="api-status">API: {status}</p>
    </main>
  );
}
`,
  }),
};

const express: StackPart = {
  area: "backend",
  id: "express",
  label: "Node + Express (TypeScript)",
  language: "typescript",
  unitFrameworks: ["vitest", "jest", "none"],
  defaultUnit: "vitest",
  install: [{ file: "npm", args: ["install"] }],
  dev: { file: "npx", args: ["tsx", "src/index.ts"], env: { PORT: "{port}" }, readyPath: "/api/health" },
  conventions: [
    "Backend: Node 22 + Express 5 + TypeScript in backend/, run with tsx. Routes under /api.",
    "src/app.ts builds and exports the Express app (no listen) so tests can use supertest; src/index.ts listens on process.env.PORT.",
  ].join("\n"),
  files: ({ projectName }) => ({
    "package.json": json({
      name: `${slug(projectName)}-api`,
      private: true,
      version: "0.1.0",
      type: "module",
      scripts: { dev: "tsx watch src/index.ts", start: "tsx src/index.ts", test: "vitest run" },
      dependencies: { express: "^5.2.1", cors: "^2.8.6" },
      devDependencies: {
        "@types/cors": "^2.8.19",
        "@types/express": "^5.0.6",
        "@types/node": "^22.15.0",
        "@types/supertest": "^7.2.1",
        supertest: "^7.3.0",
        tsx: "^4.23.15",
        typescript: "~6.0.3",
        vitest: "^5.0.3",
      },
    }),
    "tsconfig.json": json({
      compilerOptions: {
        target: "ES2023",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        allowImportingTsExtensions: true,
        skipLibCheck: true,
        types: ["node"],
      },
      include: ["src", "test"],
    }),
    "src/app.ts": `import cors from "cors";
import express from "express";

export function createApp() {
  const app = express();
  app.use(cors());
  app.use(express.json());
  app.get("/api/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  return app;
}
`,
    "src/index.ts": `import { createApp } from "./app.ts";

const port = Number(process.env.PORT ?? 3000);
createApp().listen(port, "127.0.0.1", () => {
  console.log(\`API listening on http://127.0.0.1:\${port}\`);
});
`,
  }),
};

const fastapi: StackPart = {
  area: "backend",
  id: "fastapi",
  label: "Python + FastAPI",
  language: "python",
  unitFrameworks: ["pytest", "none"],
  defaultUnit: "pytest",
  install: [{ file: "python3", args: ["-m", "pip", "install", "-r", "requirements.txt"] }],
  dev: {
    file: "python3",
    args: ["-m", "uvicorn", "app.main:app", "--host", "127.0.0.1", "--port", "{port}"],
    env: {},
    readyPath: "/api/health",
  },
  conventions: [
    "Backend: Python 3.11+ FastAPI in backend/. App object in app/main.py, routers in app/routers, Pydantic models in app/models.py.",
    "Use FastAPI's TestClient (httpx) for unit tests under backend/tests.",
  ].join("\n"),
  files: () => ({
    "requirements.txt": "fastapi>=0.115\nuvicorn[standard]>=0.30\nhttpx>=0.27\npytest>=8\n",
    "app/__init__.py": "",
    "app/main.py": `from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI()
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}
`,
    "tests/__init__.py": "",
    "pytest.ini": "[pytest]\ntestpaths = tests\n",
  }),
};

const aspnet: StackPart = {
  area: "backend",
  id: "aspnet",
  label: "ASP.NET Core (C#)",
  language: "csharp",
  unitFrameworks: ["xunit", "none"],
  defaultUnit: "xunit",
  install: [{ file: "dotnet", args: ["restore"] }],
  dev: {
    file: "dotnet",
    args: ["run", "--project", "Api", "--urls", "http://127.0.0.1:{port}"],
    env: {},
    readyPath: "/api/health",
  },
  conventions: [
    "Backend: ASP.NET Core minimal APIs (.NET 8+) in backend/Api. Endpoints under /api, records for DTOs.",
    "Unit tests live in backend/Api.Tests (xUnit) and reference Api via WebApplicationFactory where useful.",
  ].join("\n"),
  files: () => ({
    ".gitignore": "bin/\nobj/\nTestResults/\n",
    "Api/Api.csproj": `<Project Sdk="Microsoft.NET.Sdk.Web">
  <PropertyGroup>
    <TargetFramework>net8.0</TargetFramework>
    <Nullable>enable</Nullable>
    <ImplicitUsings>enable</ImplicitUsings>
  </PropertyGroup>
</Project>
`,
    "Api/Program.cs": `var builder = WebApplication.CreateBuilder(args);
builder.Services.AddCors(o => o.AddDefaultPolicy(p => p.AllowAnyOrigin().AllowAnyHeader().AllowAnyMethod()));
var app = builder.Build();
app.UseCors();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.Run();

public partial class Program { }
`,
  }),
};

export const STACK_TEMPLATES: StackTemplate[] = [
  {
    id: "node-react",
    label: "Node/Express + React",
    description: "TypeScript end to end: Express 5 API and a React + Vite UI.",
    backend: express,
    frontend: reactVite,
  },
  {
    id: "fastapi-react",
    label: "FastAPI + React",
    description: "Python FastAPI backend with a React + Vite UI.",
    backend: fastapi,
    frontend: reactVite,
  },
  {
    id: "aspnet-react",
    label: "ASP.NET Core + React",
    description: "C# minimal API backend with a React + Vite UI.",
    backend: aspnet,
    frontend: reactVite,
  },
  {
    id: "custom",
    label: "Custom (Architect decides)",
    description: "No starter files; the Architect picks the stack from your brief.",
    backend: { ...express, id: "custom", label: "Chosen by the Architect", files: () => ({}), conventions: "Backend stack: chosen by the Architect and recorded in docs/SPEC.md." },
    frontend: { ...reactVite, id: "custom", label: "Chosen by the Architect", files: () => ({}), conventions: "Frontend stack: chosen by the Architect and recorded in docs/SPEC.md." },
  },
];

export function getStack(id: string): StackTemplate {
  const stack = STACK_TEMPLATES.find((s) => s.id === id);
  if (!stack) throw new Error(`Unknown stack template: ${id}`);
  return stack;
}

/**
 * All starter files for a project, keyed by path relative to the project
 * folder (backend/... and frontend/... in both shapes).
 */
export function starterFiles(stack: StackTemplate, ctx: StackContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of [stack.backend, stack.frontend]) {
    for (const [file, content] of Object.entries(part.files(ctx))) {
      out[`${PART_DIRS[part.area]}/${file}`] = content;
    }
  }
  return out;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "app"
  );
}

function escapeHtml(text: string): string {
  // Also safe as JSX text: braces would otherwise start an expression.
  return text.replace(/[&<>"{}]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "{": "&#123;", "}": "&#125;" })[c] ?? c);
}
