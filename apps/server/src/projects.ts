import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  defaultProjectSettings,
  newId,
  nowIso,
  type Project,
  type ProjectSettings,
  type ProjectShape,
} from "@appforge/core";
import { getStack, locatePart, reposForShape, starterFiles, type StackTemplate } from "@appforge/templates";
import { GitRepo, Sandbox } from "@appforge/workspace";

export interface CreateProjectInput {
  name: string;
  path: string;
  shape: ProjectShape;
  stackId: string;
  /** Write the stack's starter files and commit them. */
  scaffold?: boolean;
  settings?: Partial<ProjectSettings>;
}

export class ProjectError extends Error {}

const FORBIDDEN_ROOTS = ["/", "/bin", "/boot", "/dev", "/etc", "/lib", "/proc", "/root", "/sbin", "/sys", "/usr", "/var", "/System", "/Library", "/Applications"];

/** Refuse folders where `git init` + agents would be a disaster. */
export async function validateProjectPath(input: string): Promise<string> {
  if (!input || !path.isAbsolute(input)) throw new ProjectError("Project folder must be an absolute path");
  const resolved = path.resolve(input);
  await mkdir(resolved, { recursive: true });
  const real = await realpath(resolved);
  const home = await realpath(os.homedir()).catch(() => os.homedir());
  if (real === home || FORBIDDEN_ROOTS.includes(real) || real.split(path.sep).filter(Boolean).length < 2) {
    throw new ProjectError(`Refusing to use ${real} as a project folder; pick or create a dedicated folder`);
  }
  return real;
}

export async function createProject(input: CreateProjectInput, existing: Project[]): Promise<Project> {
  const name = input.name?.trim();
  if (!name) throw new ProjectError("Project name is required");
  if (input.shape !== "monorepo" && input.shape !== "separate") throw new ProjectError("shape must be monorepo or separate");
  let stack: StackTemplate;
  try {
    stack = getStack(input.stackId);
  } catch (err) {
    throw new ProjectError((err as Error).message);
  }
  const projectPath = await validateProjectPath(input.path);
  for (const other of existing) {
    if (other.path === projectPath) throw new ProjectError(`${projectPath} is already the project "${other.name}"`);
    if (projectPath.startsWith(other.path + path.sep) || other.path.startsWith(projectPath + path.sep)) {
      throw new ProjectError(`${projectPath} overlaps the project "${other.name}" (${other.path})`);
    }
  }

  const repos = reposForShape(input.shape);
  if (input.shape === "separate" && existsSync(path.join(projectPath, ".git"))) {
    throw new ProjectError("This folder is already a single git repo; choose the monorepo shape or another folder");
  }
  for (const repo of repos) await GitRepo.init(path.join(projectPath, repo.path));

  const settings: ProjectSettings = {
    ...defaultProjectSettings({ unitBackend: stack.backend.defaultUnit, unitFrontend: stack.frontend.defaultUnit }),
    ...input.settings,
  };
  const project: Project = {
    id: newId("prj"),
    name,
    path: projectPath,
    shape: input.shape,
    stackId: stack.id,
    repos,
    settings,
    createdAt: nowIso(),
  };
  if (input.scaffold) await scaffoldProject(project);
  return project;
}

/**
 * Write the stack's starter files (never overwriting existing files) and
 * commit them in each repo. Returns the files written.
 */
export async function scaffoldProject(project: Project): Promise<string[]> {
  const stack = getStack(project.stackId);
  const sandbox = await Sandbox.create(project.path);
  const written: string[] = [];
  for (const [rel, content] of Object.entries(starterFiles(stack, { projectName: project.name }))) {
    const target = await sandbox.resolve(rel);
    if (existsSync(target)) continue;
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
    written.push(rel);
  }
  if (written.length) {
    const repoPaths = new Set([locatePart(project.shape, "backend").repo, locatePart(project.shape, "frontend").repo]);
    for (const repo of repoPaths) {
      await new GitRepo(path.join(project.path, repo)).commitAll(`chore: scaffold ${stack.label} (AppForge)`);
    }
  }
  return written;
}
