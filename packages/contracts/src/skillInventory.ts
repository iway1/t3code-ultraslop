import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerProviderSkill } from "./server.ts";

/**
 * One skill a provider can load somewhere on the machine. `projectIds` lists
 * the projects it loads in; absent means every project. `plugin` names the
 * plugin it ships with when it turns on and off with that plugin rather than
 * on its own.
 */
export const SkillInventorySkill = Schema.Struct({
  ...ServerProviderSkill.fields,
  /** Absent for skills built into the provider, which have no file. */
  path: Schema.optionalKey(TrimmedNonEmptyString),
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
  plugin: Schema.optionalKey(TrimmedNonEmptyString),
});
export type SkillInventorySkill = typeof SkillInventorySkill.Type;

export const SkillInventoryProvider = Schema.Struct({
  instanceId: ProviderInstanceId,
  skills: Schema.Array(SkillInventorySkill),
});
export type SkillInventoryProvider = typeof SkillInventoryProvider.Type;

/** Every skill the Skill Monitor's providers can load, across all projects. */
export const SkillInventory = Schema.Struct({
  providers: Schema.Array(SkillInventoryProvider),
  /** Skills the Skill Monitor hides, by name. Absent from older servers. */
  hiddenSkills: Schema.Array(TrimmedNonEmptyString).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type SkillInventory = typeof SkillInventory.Type;

/**
 * Hide a skill from the Skill Monitor and switch it off machine-wide in every
 * provider that lists it, or show it again and switch it back on. Copies that
 * turn on and off with a plugin are left as they are.
 */
export const SetSkillHiddenInput = Schema.Struct({
  skillName: TrimmedNonEmptyString,
  hidden: Schema.Boolean,
});
export type SetSkillHiddenInput = typeof SetSkillHiddenInput.Type;

export const SkillInventoryInput = Schema.Struct({});
export type SkillInventoryInput = typeof SkillInventoryInput.Type;
