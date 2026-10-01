import { useEffect, useState } from "react";
import type { Project, ProjectSettings, Skill } from "@appforge/core";
import { Api, KnowledgeApi, ProviderApi } from "@/lib/api.ts";
import { href } from "@/lib/router.ts";
import { ProjectSettingsForm, type ProviderOption } from "../ProjectSettingsForm.tsx";
import { Section } from "../ui/card.tsx";
import { Toggle } from "../ui/input.tsx";
import { toast } from "../ui/toast.tsx";

export function SettingsTab({ project, onChange }: { project: Project; onChange: (p: Project) => void }) {
  const [providers, setProviders] = useState<ProviderOption[]>([]);
  const [skills, setSkills] = useState<Skill[]>([]);
  useEffect(() => {
    ProviderApi.list().then((list) => setProviders(list.map((p) => ({ id: p.id, label: `${p.label}${p.status?.ok ? "" : " — not ready"}`, models: p.models }))), () => undefined);
    KnowledgeApi.skills().then(setSkills, () => undefined);
  }, []);

  const enabled = project.settings.skills ?? skills.filter((s) => s.default).map((s) => s.id);
  const toggleSkill = async (id: string, on: boolean) => {
    const next = on ? [...new Set([...enabled, id])] : enabled.filter((s) => s !== id);
    const { scaffolded: _s, ...updated } = await Api.updateProject(project.id, { settings: { skills: next } });
    onChange(updated);
  };

  return (
    <div className="max-w-3xl space-y-10">
      <ProjectSettingsForm
        project={project}
        providers={providers}
        onSave={async (settings: ProjectSettings) => {
          const { scaffolded, ...updated } = await Api.updateProject(project.id, { settings });
          onChange(updated);
          return scaffolded;
        }}
        onWriteCi={async () => (await Api.writeCi(project.id)).written}
      />
      <Section title="Skills" description="Instruction packs given to this project's agents (per role).">
        <div className="space-y-3">
          {skills.map((s) => (
            <Toggle
              key={s.id}
              checked={enabled.includes(s.id)}
              onChange={(on) => void toggleSkill(s.id, on).then(() => toast(`${s.name} ${on ? "enabled" : "disabled"}`, "success"))}
              label={s.name}
              description={`${s.description}${s.roles.length ? ` · ${s.roles.join(", ")}` : " · all roles"}`}
            />
          ))}
          <a href={href({ page: "skills" })} className="inline-block text-xs text-muted-foreground underline">
            Manage skills
          </a>
        </div>
      </Section>
    </div>
  );
}
