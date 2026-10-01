import { useEffect, useState } from "react";
import type { E2EFramework, Project, ProjectShape, UnitFramework } from "@appforge/core";
import { E2E_FRAMEWORKS } from "@appforge/core";
import { FolderPicker } from "@/components/FolderPicker.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Dialog } from "@/components/ui/dialog.tsx";
import { Field, Input, Select } from "@/components/ui/input.tsx";
import { ErrorNote } from "@/components/ui/misc.tsx";
import { Api, type StackInfo } from "@/lib/api.ts";

export function NewProjectDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (p: Project) => void }) {
  const [stacks, setStacks] = useState<StackInfo[]>([]);
  const [name, setName] = useState("");
  const [folder, setFolder] = useState("");
  const [shape, setShape] = useState<ProjectShape>("monorepo");
  const [stackId, setStackId] = useState("node-react");
  const [e2e, setE2e] = useState<E2EFramework>("playwright");
  const [unitBackend, setUnitBackend] = useState<UnitFramework>("vitest");
  const [unitFrontend, setUnitFrontend] = useState<UnitFramework>("vitest");
  const [scaffold, setScaffold] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (open) void Api.stacks().then(setStacks).catch((e: Error) => setError(e.message));
  }, [open]);

  const stack = stacks.find((s) => s.id === stackId);
  useEffect(() => {
    if (!stack) return;
    setUnitBackend(stack.backend.defaultUnit);
    setUnitFrontend(stack.frontend.defaultUnit);
  }, [stack]);

  const submit = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const project = await Api.createProject({
        name: name.trim() || folder.split(/[\\/]/).filter(Boolean).pop() || "app",
        path: folder,
        shape,
        stackId,
        scaffold: scaffold && stackId !== "custom",
        settings: { e2e, unitBackend, unitFrontend },
      });
      onCreated(project);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title="New project" description="Pick or create a folder. AppForge runs git init there and only works inside it." className="max-w-2xl">
      <div className="grid gap-4">
        <Field label="Project folder">
          <FolderPicker value={folder} onChange={setFolder} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={folder.split(/[\\/]/).filter(Boolean).pop()} />
          </Field>
          <Field label="Shape" hint={shape === "monorepo" ? "backend/ + frontend/ in one repo" : "backend/ and frontend/ as two repos"}>
            <Select value={shape} onChange={(e) => setShape(e.target.value as ProjectShape)}>
              <option value="monorepo">Monorepo</option>
              <option value="separate">Two separate repos</option>
            </Select>
          </Field>
          <Field label="Stack template" hint={stack?.description}>
            <Select value={stackId} onChange={(e) => setStackId(e.target.value)}>
              {stacks.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="E2E tests">
            <Select value={e2e} onChange={(e) => setE2e(e.target.value as E2EFramework)}>
              {E2E_FRAMEWORKS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Backend unit tests">
            <Select value={unitBackend} onChange={(e) => setUnitBackend(e.target.value as UnitFramework)}>
              {(stack?.backend.unitFrameworks ?? ["vitest"]).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </Field>
          <Field label="Frontend unit tests">
            <Select value={unitFrontend} onChange={(e) => setUnitFrontend(e.target.value as UnitFramework)}>
              {(stack?.frontend.unitFrameworks ?? ["vitest"]).map((f) => (
                <option key={f}>{f}</option>
              ))}
            </Select>
          </Field>
        </div>
        {stackId !== "custom" && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={scaffold} onChange={(e) => setScaffold(e.target.checked)} className="accent-[var(--color-primary)]" />
            Write the stack's starter files (never overwrites existing files)
          </label>
        )}
        <ErrorNote error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !folder}>
            {busy ? "Creating…" : "Create project"}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
