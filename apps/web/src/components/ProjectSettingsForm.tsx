import { useEffect, useState } from "react";
import { E2E_FRAMEWORKS, ROLES, type Project, type ProjectSettings, type RoleId, type UnitFramework } from "@appforge/core";
import { Button } from "./ui/button.tsx";
import { Field, Input, Select } from "./ui/input.tsx";
import { ErrorNote } from "./ui/misc.tsx";

export interface ProviderOption {
  id: string;
  label: string;
  models: readonly string[];
}

const ROLE_LABELS: Record<RoleId, string> = {
  architect: "Architect",
  coder: "Coder",
  reviewer: "Reviewer",
  "test-author": "Test author",
  integrator: "Integrator",
};

const UNIT: UnitFramework[] = ["vitest", "jest", "xunit", "pytest", "none"];

export function ProjectSettingsForm({
  project,
  providers,
  onSave,
}: {
  project: Project;
  providers: ProviderOption[];
  onSave: (settings: ProjectSettings) => Promise<void>;
}) {
  const [draft, setDraft] = useState<ProjectSettings>(project.settings);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  useEffect(() => setDraft(project.settings), [project.settings]);

  const set = <K extends keyof ProjectSettings>(key: K, value: ProjectSettings[K]) => {
    setSaved(false);
    setDraft((d) => ({ ...d, [key]: value }));
  };
  const setRole = (role: RoleId, patch: { provider?: string; model?: string }) => {
    setSaved(false);
    setDraft((d) => {
      const next = { ...d.roles[role], ...patch };
      if (!next.model) delete next.model;
      return { ...d, roles: { ...d.roles, [role]: next } };
    });
  };

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      await onSave(draft);
      setSaved(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <section>
        <h3 className="mb-2 text-sm font-semibold">Agents</h3>
        <p className="mb-3 text-xs text-muted-foreground">Pick a provider and model per role. Cross-vendor review (e.g. Claude codes, Codex reviews) catches more.</p>
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-sm">
            <tbody>
              {ROLES.map((role) => {
                const assignment = draft.roles[role];
                const provider = providers.find((p) => p.id === assignment.provider);
                return (
                  <tr key={role} className="border-b last:border-0">
                    <td className="w-32 px-3 py-2 font-medium">{ROLE_LABELS[role]}</td>
                    <td className="px-2 py-1.5">
                      <Select value={assignment.provider} onChange={(e) => setRole(role, { provider: e.target.value, model: "" })} aria-label={`${role} provider`}>
                        {!provider && <option value={assignment.provider}>{assignment.provider}</option>}
                        {providers.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.label}
                          </option>
                        ))}
                      </Select>
                    </td>
                    <td className="px-2 py-1.5">
                      <Input
                        list={`models-${role}`}
                        value={assignment.model ?? ""}
                        placeholder="default model"
                        onChange={(e) => setRole(role, { model: e.target.value })}
                        aria-label={`${role} model`}
                      />
                      <datalist id={`models-${role}`}>
                        {provider?.models.map((m) => <option key={m} value={m} />)}
                      </datalist>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      <section className="grid gap-4 sm:grid-cols-3">
        <Field label="E2E framework">
          <Select value={draft.e2e} onChange={(e) => set("e2e", e.target.value as ProjectSettings["e2e"])}>
            {E2E_FRAMEWORKS.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </Select>
        </Field>
        <Field label="Backend unit tests">
          <Select value={draft.unitBackend} onChange={(e) => set("unitBackend", e.target.value as UnitFramework)}>
            {UNIT.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </Select>
        </Field>
        <Field label="Frontend unit tests">
          <Select value={draft.unitFrontend} onChange={(e) => set("unitFrontend", e.target.value as UnitFramework)}>
            {UNIT.map((f) => (
              <option key={f}>{f}</option>
            ))}
          </Select>
        </Field>
        <Field label="Swarm concurrency" hint="Agents running at once (1–8). Start at 3.">
          <Input type="number" min={1} max={8} value={draft.concurrency} onChange={(e) => set("concurrency", Number(e.target.value))} />
        </Field>
        <Field label="Fix loops" hint="Review/test retries per task.">
          <Input type="number" min={0} max={10} value={draft.maxFixLoops} onChange={(e) => set("maxFixLoops", Number(e.target.value))} />
        </Field>
        <Field label="Budget per run (USD)" hint="Stops the run when reported spend passes it. Empty = no cap.">
          <Input
            type="number"
            min={0}
            step="0.5"
            value={draft.budgetUsd ?? ""}
            onChange={(e) => {
              const v = e.target.value;
              setDraft((d) => {
                const next = { ...d };
                if (v === "") delete next.budgetUsd;
                else next.budgetUsd = Number(v);
                return next;
              });
            }}
          />
        </Field>
      </section>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" checked={draft.requireApproval} onChange={(e) => set("requireApproval", e.target.checked)} />
        Require my approval before every merge
      </label>
      <ErrorNote error={error} />
      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save settings"}
        </Button>
        {saved && <span className="text-sm text-success">Saved</span>}
      </div>
    </div>
  );
}
