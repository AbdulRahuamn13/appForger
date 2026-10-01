import { Download, Plus, RotateCcw, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { ROLES, type RoleId, type Skill } from "@appforge/core";
import { Page, PageHeader } from "@/components/Layout.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Field, Input, Textarea, Toggle } from "@/components/ui/input.tsx";
import { Markdown } from "@/components/ui/markdown.tsx";
import { ErrorNote, Tabs } from "@/components/ui/misc.tsx";
import { toast } from "@/components/ui/toast.tsx";
import { KnowledgeApi, SettingsApi } from "@/lib/api.ts";
import { cn } from "@/lib/utils.ts";

type Draft = { id?: string; name: string; description: string; roles: RoleId[]; default: boolean; body: string };
const EMPTY: Draft = { name: "", description: "", roles: [], default: true, body: "" };

/** Skills: reusable instructions for agents (SKILL.md format, same as Claude Code). Stored in your chosen storage. */
export function SkillsPage() {
  const [skills, setSkills] = useState<Skill[]>();
  const [selected, setSelected] = useState<string>();
  const [draft, setDraft] = useState<Draft>();
  const [view, setView] = useState<"edit" | "preview">("preview");
  const [importing, setImporting] = useState(false);
  const [location, setLocation] = useState("");
  const [error, setError] = useState<string>();

  const load = async (select?: string) => {
    const list = await KnowledgeApi.skills();
    setSkills(list);
    const pick = list.find((s) => s.id === (select ?? selected)) ?? list[0];
    if (pick) choose(pick);
  };
  useEffect(() => {
    void load();
    SettingsApi.storage().then((s) => setLocation(s.location), () => undefined);
  }, []);

  function choose(s: Skill) {
    setSelected(s.id);
    setDraft({ id: s.id, name: s.name, description: s.description, roles: s.roles, default: s.default, body: s.body });
    setView("preview");
    setError(undefined);
  }

  const current = skills?.find((s) => s.id === selected);
  const save = async () => {
    if (!draft) return;
    try {
      const body = { name: draft.name, description: draft.description, roles: draft.roles, default: draft.default, body: draft.body };
      const saved = draft.id ? await KnowledgeApi.saveSkill(draft.id, body) : await KnowledgeApi.createSkill(body);
      toast(`Saved "${saved.name}"`, "success");
      await load(saved.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  return (
    <Page wide>
      <PageHeader
        title="Skills"
        description={
          <>
            Reusable instructions agents follow, per role. Compatible with Claude Code <code className="font-mono text-xs">SKILL.md</code> files. Stored in {location || "your storage"}.
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => setImporting(true)}>
              <Download /> Import
            </Button>
            <Button
              onClick={() => {
                setSelected(undefined);
                setDraft({ ...EMPTY });
                setView("edit");
              }}
            >
              <Plus /> New skill
            </Button>
          </>
        }
      />
      <div className="grid grid-cols-[17rem_1fr] gap-8">
        <ul className="space-y-0.5" data-testid="skill-list">
          {skills?.map((s) => (
            <li key={s.id}>
              <button type="button" onClick={() => choose(s)} className={cn("w-full rounded-md px-3 py-2 text-left hover:bg-muted", selected === s.id && "bg-muted")}>
                <div className="flex items-center gap-2 text-[13px] font-medium">
                  {s.name}
                  {s.builtIn && <span className="text-[10px] font-normal text-muted-foreground">built-in</span>}
                </div>
                <div className="truncate text-xs text-muted-foreground">{s.description || "—"}</div>
              </button>
            </li>
          ))}
        </ul>
        {draft && (
          <div className="min-w-0 space-y-5">
            <div className="grid grid-cols-2 gap-4">
              <Field label="Name">
                <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Skill name" />
              </Field>
              <Field label="Description">
                <Input value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="Skill description" />
              </Field>
            </div>
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-muted-foreground">Roles (none selected = every role)</div>
              <div className="flex flex-wrap gap-1.5">
                {ROLES.map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setDraft({ ...draft, roles: draft.roles.includes(r) ? draft.roles.filter((x) => x !== r) : [...draft.roles, r] })}
                    className={cn("rounded-full border px-2.5 py-0.5 text-xs", draft.roles.includes(r) ? "border-foreground text-foreground" : "text-muted-foreground")}
                  >
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <Toggle checked={draft.default} onChange={(v) => setDraft({ ...draft, default: v })} label="On by default" description="New projects get this skill unless you turn it off in project settings." />
            <div className="space-y-2">
              <Tabs
                value={view}
                onChange={setView}
                tabs={[
                  { value: "preview", label: "Preview" },
                  { value: "edit", label: "Edit" },
                ]}
              />
              {view === "edit" ? (
                <Textarea
                  value={draft.body}
                  onChange={(e) => setDraft({ ...draft, body: e.target.value })}
                  rows={18}
                  className="font-mono text-xs"
                  placeholder={"- Use Zod to validate every request body\n- Return 400 with { error: { code, message } }"}
                  aria-label="Skill instructions"
                />
              ) : (
                <div className="min-h-40 rounded-lg border px-4 py-3">{draft.body ? <Markdown>{draft.body}</Markdown> : <p className="text-xs text-muted-foreground">No instructions yet.</p>}</div>
              )}
            </div>
            {current && current.files.length > 0 && (
              <div className="text-xs text-muted-foreground">
                Files: {current.files.map((f) => <Badge key={f} className="mr-1">{f}</Badge>)}
              </div>
            )}
            <ErrorNote error={error} />
            <div className="flex justify-between border-t pt-4">
              <div>
                {current && (
                  <Button
                    variant="ghost"
                    onClick={() => {
                      const msg = current.builtIn ? "Reset this skill to the built-in version?" : `Delete "${current.name}"?`;
                      if (confirm(msg)) void KnowledgeApi.deleteSkill(current.id).then(() => load());
                    }}
                  >
                    {current.builtIn ? <RotateCcw /> : <Trash2 />} {current.builtIn ? "Reset to built-in" : "Delete"}
                  </Button>
                )}
              </div>
              <Button onClick={() => void save()} disabled={!draft.name.trim() || !draft.body.trim()}>
                Save skill
              </Button>
            </div>
          </div>
        )}
      </div>
      <ImportDialog open={importing} onClose={() => setImporting(false)} onImported={(id) => void load(id)} />
    </Page>
  );
}

function ImportDialog({ open, onClose, onImported }: { open: boolean; onClose: () => void; onImported: (id?: string) => void }) {
  const [path, setPath] = useState("");
  const [markdown, setMarkdown] = useState("");
  const [error, setError] = useState<string>();
  const run = async (body: { path?: string; markdown?: string }) => {
    try {
      const { imported } = await KnowledgeApi.importSkills(body);
      toast(`Imported ${imported.map((s) => s.name).join(", ")}`, "success");
      onClose();
      onImported(imported[0]?.id);
    } catch (err) {
      setError((err as Error).message);
    }
  };
  return (
    <Dialog open={open} onClose={onClose} title="Import skills" description="From a folder on this machine, or paste a SKILL.md.">
      <div className="space-y-5">
        <Field label="Folder" hint="A skill folder (with SKILL.md) or a folder of skills, e.g. ~/.claude/skills — use the full path.">
          <div className="flex gap-2">
            <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/home/you/.claude/skills" className="font-mono text-xs" aria-label="Skills folder" />
            <Button variant="outline" disabled={!path.trim()} onClick={() => void run({ path: path.trim() })}>
              Import
            </Button>
          </div>
        </Field>
        <Field label="Or paste SKILL.md">
          <Textarea value={markdown} onChange={(e) => setMarkdown(e.target.value)} rows={8} className="font-mono text-xs" placeholder={"---\nname: My skill\ndescription: ...\n---\n\nInstructions…"} />
        </Field>
        <ErrorNote error={error} />
        <div className="flex justify-end">
          <Button disabled={!markdown.trim()} onClick={() => void run({ markdown })}>
            Import pasted skill
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
