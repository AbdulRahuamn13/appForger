import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { parse, stringify } from "yaml";
import type { RoleId, Skill } from "@appforge/core";
import { ROLES, slugify, truncate } from "@appforge/core";
import { checkKey, type BlobStore } from "./blob.ts";
import { BUILT_IN_SKILLS } from "./builtin-skills.ts";

const SKILL_FILE = "SKILL.md";
const MAX_SKILL_FILE_BYTES = 1_000_000;
const MAX_SKILL_FILES = 50;

export interface ParsedSkill {
  name: string;
  description: string;
  roles: RoleId[];
  default: boolean;
  body: string;
}

/** Parse a SKILL.md (YAML frontmatter + Markdown body), the format Claude Code and Agent Skills use. */
export function parseSkillMarkdown(text: string, fallbackName = "skill"): ParsedSkill {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  let meta: Record<string, unknown> = {};
  let body = text;
  if (match) {
    try {
      const parsed = parse(match[1] ?? "") as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) meta = parsed as Record<string, unknown>;
    } catch {
      // treat as plain markdown
    }
    body = match[2] ?? "";
  }
  const rolesRaw = Array.isArray(meta.roles) ? meta.roles : typeof meta.roles === "string" ? meta.roles.split(",") : [];
  const roles = rolesRaw.map((r) => String(r).trim()).filter((r): r is RoleId => (ROLES as readonly string[]).includes(r));
  const firstHeading = /^#\s+(.+)$/m.exec(body)?.[1]?.trim();
  return {
    name: typeof meta.name === "string" && meta.name.trim() ? meta.name.trim() : (firstHeading ?? fallbackName),
    description: typeof meta.description === "string" ? meta.description.trim() : "",
    roles,
    default: meta.default === undefined ? true : Boolean(meta.default),
    body: body.trim(),
  };
}

export function formatSkillMarkdown(skill: Pick<Skill, "name" | "description" | "roles" | "default" | "body">): string {
  const meta: Record<string, unknown> = { name: skill.name, description: skill.description };
  if (skill.roles.length) meta.roles = skill.roles;
  meta.default = skill.default;
  return `---\n${stringify(meta).trim()}\n---\n\n${skill.body.trim()}\n`;
}

/**
 * Skills live in the active BlobStore under skills/<id>/SKILL.md (plus any
 * extra files). Built-in skills ship with AppForge; saving one stores your
 * edited copy, which then wins.
 */
export class SkillLibrary {
  constructor(private readonly store: () => BlobStore) {}

  async list(): Promise<Skill[]> {
    const blobs = await this.store().list("skills/");
    const byId = new Map<string, { md?: { key: string; updatedAt: string }; files: string[] }>();
    for (const b of blobs) {
      const [, id, ...rest] = b.key.split("/");
      if (!id || !rest.length) continue;
      const entry = byId.get(id) ?? { files: [] };
      const rel = rest.join("/");
      if (rel === SKILL_FILE) entry.md = { key: b.key, updatedAt: b.updatedAt };
      else entry.files.push(rel);
      byId.set(id, entry);
    }
    const out = new Map<string, Skill>();
    for (const builtIn of BUILT_IN_SKILLS) out.set(builtIn.id, builtIn);
    for (const [id, entry] of byId) {
      if (!entry.md) continue;
      const text = (await this.store().get(entry.md.key))?.toString("utf8") ?? "";
      const parsed = parseSkillMarkdown(text, id);
      out.set(id, { id, ...parsed, files: entry.files.sort(), builtIn: BUILT_IN_SKILLS.some((b) => b.id === id), updatedAt: entry.md.updatedAt });
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  async get(id: string): Promise<Skill | undefined> {
    return (await this.list()).find((s) => s.id === id);
  }

  async readFile(id: string, file: string): Promise<Buffer | undefined> {
    return this.store().get(`skills/${checkKey(id)}/${checkKey(file)}`);
  }

  /** Create or update a skill. Returns the stored skill. */
  async save(input: { id?: string; name: string; description: string; roles: RoleId[]; default: boolean; body: string }, files: Record<string, Buffer | string> = {}): Promise<Skill> {
    if (!input.name.trim()) throw new Error("A skill needs a name");
    if (!input.body.trim()) throw new Error("A skill needs instructions");
    const id = input.id ? checkKey(input.id) : slugify(input.name, 48);
    await this.store().put(`skills/${id}/${SKILL_FILE}`, formatSkillMarkdown(input), "text/markdown");
    for (const [rel, data] of Object.entries(files)) {
      if (rel === SKILL_FILE) continue;
      await this.store().put(`skills/${id}/${checkKey(rel)}`, data);
    }
    const saved = await this.get(id);
    if (!saved) throw new Error("Skill could not be saved");
    return saved;
  }

  async delete(id: string): Promise<void> {
    for (const b of await this.store().list(`skills/${checkKey(id)}/`)) await this.store().delete(b.key);
  }

  /**
   * Import skills from a folder on this machine: either one skill folder
   * (contains SKILL.md) or a folder of skill folders (e.g. ~/.claude/skills).
   */
  async importFromPath(dir: string): Promise<Skill[]> {
    const st = await stat(dir).catch(() => undefined);
    if (!st?.isDirectory()) throw new Error(`Not a folder: ${dir}`);
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === "skill.md")) return [await this.importOne(dir)];
    const imported: Skill[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const sub = path.join(dir, e.name);
      const files = await readdir(sub).catch(() => [] as string[]);
      if (files.some((f) => f.toLowerCase() === "skill.md")) imported.push(await this.importOne(sub));
    }
    if (!imported.length) throw new Error(`No SKILL.md found in ${dir} or its sub-folders`);
    return imported;
  }

  private async importOne(dir: string): Promise<Skill> {
    const names = await readdir(dir, { recursive: true });
    const mdName = names.find((n) => n.toLowerCase() === "skill.md") ?? SKILL_FILE;
    const parsed = parseSkillMarkdown(await readFile(path.join(dir, mdName), "utf8"), path.basename(dir));
    const files: Record<string, Buffer> = {};
    for (const rel of names) {
      if (rel === mdName || Object.keys(files).length >= MAX_SKILL_FILES) continue;
      const full = path.join(dir, rel);
      const fst = await stat(full);
      if (!fst.isFile() || fst.size > MAX_SKILL_FILE_BYTES || rel.split(path.sep).some((p) => p.startsWith(".") || p === "node_modules")) continue;
      files[rel.split(path.sep).join("/")] = await readFile(full);
    }
    return this.save({ id: slugify(path.basename(dir), 48), ...parsed }, files);
  }

  /** Skills enabled for a project (undefined setting = every skill marked default). */
  async enabledFor(enabled: string[] | undefined): Promise<Skill[]> {
    const all = await this.list();
    return enabled ? all.filter((s) => enabled.includes(s.id)) : all.filter((s) => s.default);
  }
}

/** Skills relevant to a role, rendered for the system prompt. */
export function skillsPrompt(skills: Skill[], role: RoleId, maxPerSkill = 6_000): string {
  const relevant = skills.filter((s) => s.roles.length === 0 || s.roles.includes(role));
  if (!relevant.length) return "";
  return [
    "## Skills",
    "Follow these project skills. Extra skill files (if any) are under .appforge/context/skills/<id>/.",
    ...relevant.map((s) => `### ${s.name}${s.description ? ` — ${s.description}` : ""}\n${truncate(s.body, maxPerSkill)}`),
  ].join("\n\n");
}
