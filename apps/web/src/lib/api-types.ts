export type { Asset, ExecutionMode as ExecutionModeDto, LogFileInfo, PreviewState, RoleId, Skill, StorageSettings, Story, StoryPlan } from "@appforge/core";

export interface DoctorCheckDto {
  name: string;
  ok: boolean;
  detail: string;
  optional?: boolean;
  hint?: string;
}
