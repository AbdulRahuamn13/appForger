import { useState } from "react";
import type { ExecutionMode, Project, StoryPlan } from "@appforge/core";
import { cn } from "@/lib/utils.ts";
import { Button } from "../ui/button.tsx";
import { Dialog } from "../ui/dialog.tsx";
import { Field, Select } from "../ui/input.tsx";

const MODES: { value: ExecutionMode; label: string; description: string }[] = [
  { value: "pipeline", label: "Pipeline", description: "One task at a time: code → review → tests → merge. Predictable and easiest on plan limits." },
  { value: "swarm", label: "Swarm", description: "Independent tasks run in parallel in separate worktrees, each with its own files. Fastest for bigger plans." },
  { value: "single", label: "Single agent", description: "One agent builds the whole plan on one branch and you steer it turn by turn." },
  { value: "swarm-native", label: "Claude agent team", description: "Hands the plan to Claude Code's Agent Teams to coordinate itself (Claude only)." },
];

/** What we'd suggest: parallel-friendly plans go to a swarm. */
export function recommendMode(plan: StoryPlan): ExecutionMode {
  const independent = plan.tasks.filter((t) => t.dependsOn.length === 0).length;
  if (plan.tasks.length >= 3 && independent >= 2) return "swarm";
  if (plan.tasks.length === 1) return "single";
  return "pipeline";
}

export function ModeChooser({
  open,
  plan,
  project,
  onClose,
  onChoose,
}: {
  open: boolean;
  plan: StoryPlan;
  project: Project;
  onClose: () => void;
  onChoose: (mode: ExecutionMode, repo?: string) => void;
}) {
  const recommended = recommendMode(plan);
  const [mode, setMode] = useState<ExecutionMode>(recommended);
  const [repo, setRepo] = useState(project.repos[0]?.path ?? ".");
  const choice = MODES.find((m) => m.value === mode);
  return (
    <Dialog open={open} onClose={onClose} title="How should this be built?" description={`${plan.tasks.length} task(s) in the approved plan.`}>
      <div className="space-y-4">
        <div className="grid gap-2" role="radiogroup" aria-label="Execution mode">
          {MODES.map((m) => (
            <button
              key={m.value}
              type="button"
              role="radio"
              aria-checked={mode === m.value}
              onClick={() => setMode(m.value)}
              className={cn("rounded-lg border px-3 py-2.5 text-left transition-colors hover:bg-muted", mode === m.value && "border-foreground")}
            >
              <div className="flex items-center gap-2 text-[13px] font-medium">
                {m.label}
                {m.value === recommended && <span className="rounded-full bg-muted px-1.5 text-[10px] font-normal text-muted-foreground">recommended</span>}
              </div>
              <div className="mt-0.5 text-xs text-muted-foreground">{m.description}</div>
            </button>
          ))}
        </div>
        {project.shape === "separate" && (mode === "single" || mode === "swarm-native") && (
          <Field label="Repository">
            <Select value={repo} onChange={(e) => setRepo(e.target.value)}>
              {project.repos.map((r) => (
                <option key={r.path}>{r.path}</option>
              ))}
            </Select>
          </Field>
        )}
        {mode === "swarm" && <p className="text-xs text-muted-foreground">Up to {project.settings.concurrency} agents at once (change in project settings).</p>}
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => onChoose(mode, project.shape === "separate" ? repo : undefined)}>Build with {choice?.label}</Button>
        </div>
      </div>
    </Dialog>
  );
}
