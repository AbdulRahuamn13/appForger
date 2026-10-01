import { existsSync } from "node:fs";
import { mkdir, readdir, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FastifyInstance } from "fastify";

export interface DirEntry {
  name: string;
  path: string;
  isGitRepo: boolean;
}

export interface DirListing {
  path: string;
  parent?: string;
  entries: DirEntry[];
  shortcuts: { label: string; path: string }[];
}

/**
 * Server-side folder browser so the UI can pick or create a project folder
 * (browsers can't hand us a real path). Lists directories only.
 */
export function fsRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: { path?: string; hidden?: string } }>("/api/fs/list", async (req, reply) => {
    const target = req.query.path ? path.resolve(req.query.path) : os.homedir();
    let real: string;
    try {
      real = await realpath(target);
      if (!(await stat(real)).isDirectory()) return reply.code(400).send({ error: "Not a directory" });
    } catch {
      return reply.code(404).send({ error: `Folder not found: ${target}` });
    }
    const showHidden = req.query.hidden === "1";
    let names: string[];
    try {
      const dirents = await readdir(real, { withFileTypes: true });
      names = dirents.filter((d) => d.isDirectory() && (showHidden || !d.name.startsWith("."))).map((d) => d.name);
    } catch {
      return reply.code(403).send({ error: `Cannot read ${real}` });
    }
    names.sort((a, b) => a.localeCompare(b));
    const entries = names
      .filter((n) => n !== "node_modules")
      .map((name) => {
        const full = path.join(real, name);
        return { name, path: full, isGitRepo: existsSync(path.join(full, ".git")) };
      });
    const parent = path.dirname(real);
    const listing: DirListing = { path: real, entries, shortcuts: shortcuts() };
    if (parent !== real) listing.parent = parent;
    return listing;
  });

  app.post<{ Body: { parent: string; name: string } }>("/api/fs/mkdir", async (req, reply) => {
    const { parent, name } = req.body ?? {};
    if (!parent || !name || /[\\/]/.test(name) || name === "." || name === "..") {
      return reply.code(400).send({ error: "Give a parent folder and a plain folder name" });
    }
    const full = path.join(path.resolve(parent), name);
    await mkdir(full, { recursive: true });
    return { path: await realpath(full) };
  });
}

function shortcuts(): { label: string; path: string }[] {
  const home = os.homedir();
  const out = [{ label: "Home", path: home }];
  for (const name of ["Projects", "projects", "code", "src", "dev", "Documents"]) {
    const p = path.join(home, name);
    if (existsSync(p)) out.push({ label: name, path: p });
  }
  return out;
}
