import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

export class SandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SandboxError";
  }
}

export function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

/**
 * A folder agents are locked to. Every path is resolved through real paths, so
 * `..` tricks and symlinks pointing outside the folder are rejected.
 */
export class Sandbox {
  private constructor(readonly root: string) {}

  static async create(root: string): Promise<Sandbox> {
    const real = await realpath(path.resolve(root));
    const stat = await lstat(real);
    if (!stat.isDirectory()) throw new SandboxError(`${root} is not a directory`);
    return new Sandbox(real);
  }

  /** Resolve `target` (absolute, or relative to the root) to a real path inside the root. */
  async resolve(target: string): Promise<string> {
    const abs = path.resolve(this.root, target);
    if (!isWithin(this.root, abs)) throw new SandboxError(`Path escapes the project folder: ${target}`);
    const real = await realpathOfNearestExisting(abs);
    if (!isWithin(this.root, real)) throw new SandboxError(`Path resolves outside the project folder via a symlink: ${target}`);
    return real;
  }

  /** Like resolve() but returns undefined instead of throwing. */
  async tryResolve(target: string): Promise<string | undefined> {
    try {
      return await this.resolve(target);
    } catch {
      return undefined;
    }
  }

  relative(abs: string): string {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }
}

/** realpath() for paths that may not exist yet: resolve the deepest existing ancestor. */
export async function realpathOfNearestExisting(abs: string): Promise<string> {
  const pending: string[] = [];
  let current = abs;
  for (;;) {
    try {
      const real = await realpath(current);
      return pending.length ? path.join(real, ...pending.reverse()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw err;
      // A dangling symlink must not be silently treated as a new file.
      try {
        const st = await lstat(current);
        if (st.isSymbolicLink()) throw new SandboxError(`Dangling symlink: ${current}`);
      } catch (inner) {
        if (inner instanceof SandboxError) throw inner;
      }
      const parent = path.dirname(current);
      if (parent === current) return abs;
      pending.push(path.basename(current));
      current = parent;
    }
  }
}
