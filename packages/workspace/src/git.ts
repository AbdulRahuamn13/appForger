import { existsSync } from "node:fs";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import type { FileDiff } from "@appforge/core";

const AUTHOR = { name: "AppForge", email: "appforge@localhost" };
/** Folder (inside each repo) for AppForge's worktrees and scratch files; never committed. */
export const APPFORGE_DIR = ".appforge";

export const LOCAL_EXCLUDES = [
  `${APPFORGE_DIR}/`,
  "node_modules/",
  ".venv/",
  "__pycache__/",
  ".pytest_cache/",
  "test-results/",
  "playwright-report/",
  "blob-report/",
  "TestResults/",
  "cypress/videos/",
  "cypress/screenshots/",
];

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "untracked";
}

export interface MergeResult {
  ok: boolean;
  conflicts: string[];
  sha?: string;
}

/** Thin, typed wrapper over simple-git for the operations the orchestrator needs. */
export class GitRepo {
  readonly git: SimpleGit;

  constructor(readonly dir: string) {
    this.git = simpleGit({ baseDir: dir, trimmed: false }).env(safeEnv());
  }

  /**
   * Make `dir` a git repo on branch main with at least one commit, and keep
   * .appforge/ out of git. Safe to call on an existing repo.
   */
  static async init(dir: string): Promise<GitRepo> {
    await mkdir(dir, { recursive: true });
    const repo = new GitRepo(dir);
    if (!(await repo.isRepoRoot())) {
      await repo.git.init(["--initial-branch=main"]);
    }
    // Tool output that must never be committed or count as an agent's change.
    for (const pattern of LOCAL_EXCLUDES) await repo.ensureExcluded(pattern);
    // Commits need an identity; only set a repo-local one if the user has none.
    const email = await repo.git.raw(["config", "--get", "user.email"]).catch(() => "");
    if (!email.trim()) {
      await repo.git.addConfig("user.name", AUTHOR.name);
      await repo.git.addConfig("user.email", AUTHOR.email);
    }
    if (!(await repo.hasCommits())) {
      const gitignore = path.join(dir, ".gitignore");
      let existing = "";
      try {
        existing = await readFile(gitignore, "utf8");
      } catch {
        // no .gitignore yet
      }
      if (!existing.includes("node_modules")) {
        await writeFile(gitignore, `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}node_modules/\ndist/\n${APPFORGE_DIR}/\n`);
      }
      await repo.git.add(["-A"]);
      await repo.git.commit("chore: initialise repository (AppForge)", undefined, { "--allow-empty": null });
    }
    return repo;
  }

  async isRepoRoot(): Promise<boolean> {
    try {
      const top = (await this.git.revparse(["--show-toplevel"])).trim();
      return path.resolve(top) === path.resolve(this.dir) || (await samePath(top, this.dir));
    } catch {
      return false;
    }
  }

  async hasCommits(): Promise<boolean> {
    try {
      await this.git.revparse(["--verify", "HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  async currentBranch(): Promise<string> {
    return (await this.git.revparse(["--abbrev-ref", "HEAD"])).trim();
  }

  async headSha(ref = "HEAD"): Promise<string> {
    return (await this.git.revparse([ref])).trim();
  }

  async branchExists(branch: string): Promise<boolean> {
    try {
      await this.git.revparse(["--verify", `refs/heads/${branch}`]);
      return true;
    } catch {
      return false;
    }
  }

  async ensureExcluded(pattern: string): Promise<void> {
    const commonDir = (await this.git.revparse(["--git-common-dir"])).trim();
    const infoDir = path.resolve(this.dir, commonDir, "info");
    await mkdir(infoDir, { recursive: true });
    const excludeFile = path.join(infoDir, "exclude");
    let content = "";
    try {
      content = await readFile(excludeFile, "utf8");
    } catch {
      // created below
    }
    if (!content.split("\n").includes(pattern)) {
      await writeFile(excludeFile, `${content}${content && !content.endsWith("\n") ? "\n" : ""}${pattern}\n`);
    }
  }

  /**
   * Stage everything (or only `paths`) and commit. Returns the new sha, or
   * undefined if there was nothing to commit.
   */
  async commitAll(message: string, paths?: string[]): Promise<string | undefined> {
    if (paths) {
      paths = paths.filter((p) => existsSync(path.join(this.dir, p)));
      if (!paths.length) return undefined;
      await this.git.raw(["add", "-A", "--", ...paths]);
    } else await this.git.add(["-A"]);
    const staged = (await this.git.raw(["diff", "--cached", "--name-only"])).trim();
    if (!staged) return undefined;
    await this.git.raw(["commit", "-m", message, ...(paths ? ["--", ...paths] : [])]);
    return this.headSha();
  }

  /** Files changed in the working tree relative to HEAD, including untracked ones. */
  async changedFiles(): Promise<ChangedFile[]> {
    const status = await this.git.status(["--untracked-files=all"]);
    return status.files
      .filter((f) => !f.path.startsWith(`${APPFORGE_DIR}/`))
      .map((f) => {
        const code = `${f.index}${f.working_dir}`;
        let kind: ChangedFile["status"] = "modified";
        if (code === "??") kind = "untracked";
        else if (code.includes("A")) kind = "added";
        else if (code.includes("D")) kind = "deleted";
        else if (code.includes("R")) kind = "renamed";
        return { path: f.path, status: kind };
      });
  }

  /** Throw away working-tree changes to the given paths (tracked → HEAD, untracked → deleted). */
  async revertPaths(paths: string[]): Promise<void> {
    if (!paths.length) return;
    const changed = new Map((await this.changedFiles()).map((f) => [f.path, f.status]));
    const tracked: string[] = [];
    for (const p of paths) {
      const st = changed.get(p);
      if (st === "untracked" || st === "added") {
        await this.git.raw(["rm", "--cached", "--ignore-unmatch", "-q", "--", p]).catch(() => undefined);
        await rm(path.join(this.dir, p), { force: true, recursive: true });
      } else tracked.push(p);
    }
    if (tracked.length) await this.git.raw(["checkout", "HEAD", "--", ...tracked]);
  }

  async createWorktree(worktreePath: string, branch: string, base = "HEAD"): Promise<void> {
    await mkdir(path.dirname(worktreePath), { recursive: true });
    if (await this.branchExists(branch)) {
      await this.git.raw(["worktree", "add", worktreePath, branch]);
    } else {
      await this.git.raw(["worktree", "add", "-b", branch, worktreePath, base]);
    }
  }

  async removeWorktree(worktreePath: string): Promise<void> {
    await this.git.raw(["worktree", "remove", "--force", worktreePath]).catch(() => undefined);
    await rm(worktreePath, { recursive: true, force: true });
    await this.git.raw(["worktree", "prune"]).catch(() => undefined);
  }

  async listWorktrees(): Promise<string[]> {
    const out = await this.git.raw(["worktree", "list", "--porcelain"]);
    return out
      .split("\n")
      .filter((l) => l.startsWith("worktree "))
      .map((l) => l.slice("worktree ".length));
  }

  async deleteBranch(branch: string): Promise<void> {
    await this.git.raw(["branch", "-D", branch]).catch(() => undefined);
  }

  /** Unified diff of `head` against the merge base with `base`. */
  async diffText(base: string, head: string): Promise<string> {
    return this.git.raw(["diff", "--no-color", `${base}...${head}`]);
  }

  async diffStat(base: string, head: string): Promise<string> {
    return this.git.raw(["diff", "--stat", "--no-color", `${base}...${head}`]);
  }

  /** Per-file before/after contents for the Monaco diff view. */
  async diffFiles(base: string, head: string, maxBytes = 400_000): Promise<FileDiff[]> {
    const mergeBase = (await this.git.raw(["merge-base", base, head])).trim();
    const out = await this.git.raw(["diff", "--name-status", "-M", "--no-color", mergeBase, head]);
    const files: FileDiff[] = [];
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [code = "", a = "", b] = line.split("\t");
      let status: FileDiff["status"] = "modified";
      let filePath = a;
      let oldPath: string | undefined;
      if (code.startsWith("A")) status = "added";
      else if (code.startsWith("D")) status = "deleted";
      else if (code.startsWith("R")) {
        status = "renamed";
        oldPath = a;
        filePath = b ?? a;
      }
      const before = status === "added" ? "" : await this.show(mergeBase, oldPath ?? filePath, maxBytes);
      const after = status === "deleted" ? "" : await this.show(head, filePath, maxBytes);
      const diff: FileDiff = { path: filePath, status, before, after };
      if (oldPath) diff.oldPath = oldPath;
      files.push(diff);
    }
    return files;
  }

  private async show(ref: string, file: string, maxBytes: number): Promise<string> {
    try {
      const text = await this.git.show([`${ref}:${file}`]);
      if (text.includes("\u0000")) return "[binary file]";
      return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n[truncated]` : text;
    } catch {
      return "";
    }
  }

  /** Files changed on `head` since it diverged from `base`. */
  async changedSince(base: string, head: string): Promise<string[]> {
    const out = await this.git.raw(["diff", "--name-only", `${base}...${head}`]);
    return out.split("\n").filter(Boolean);
  }

  /** Merge `branch` into the current branch with a merge commit. Leaves conflicts in place on failure. */
  async merge(branch: string, message: string): Promise<MergeResult> {
    let failed = false;
    try {
      await this.git.raw(["merge", "--no-ff", "--no-edit", "-m", message, branch]);
    } catch {
      failed = true;
    }
    // simple-git does not always throw on a conflicted merge, so check state.
    const conflicts = await this.conflictedFiles();
    if (failed || conflicts.length || (await this.isMerging())) return { ok: false, conflicts };
    return { ok: true, conflicts: [], sha: await this.headSha() };
  }

  async conflictedFiles(): Promise<string[]> {
    const out = await this.git.raw(["diff", "--name-only", "--diff-filter=U"]);
    return out.split("\n").filter(Boolean);
  }

  async isMerging(): Promise<boolean> {
    try {
      await this.git.revparse(["--verify", "MERGE_HEAD"]);
      return true;
    } catch {
      return false;
    }
  }

  async abortMerge(): Promise<void> {
    await this.git.raw(["merge", "--abort"]).catch(() => undefined);
  }

  /** Conclude an in-progress merge after conflicts were resolved in the working tree. */
  async concludeMerge(message: string): Promise<string> {
    await this.git.add(["-A"]);
    await this.git.raw(["commit", "--no-edit", "-m", message]);
    return this.headSha();
  }

  async log(max = 20): Promise<{ sha: string; message: string; date: string }[]> {
    const log = await this.git.log({ maxCount: max });
    return log.all.map((c) => ({ sha: c.hash, message: c.message, date: c.date }));
  }
}

/** process.env minus variables that would let git run arbitrary programs (simple-git rejects them anyway). */
function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("GIT_") || key === "EDITOR" || key === "VISUAL" || key === "PAGER" || key === "SSH_ASKPASS") continue;
    env[key] = value;
  }
  return env;
}

async function samePath(a: string, b: string): Promise<boolean> {
  try {
    return (await realpath(a)) === (await realpath(b));
  } catch {
    return false;
  }
}
