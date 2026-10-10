/**
 * SkillInventory — every skill the Skill Monitor's providers can load, in any
 * project folder or thread worktree on this server, and the machine-wide
 * switch for each.
 *
 * Providers list their own folders (`ProviderInstance.listSkills`), so this
 * service only gathers the folders, merges each provider's lists by skill
 * name, and records which projects load each one. Skills every project loads
 * carry no project list, which keeps user and built-in skills to one entry.
 * Hidden skills are kept by name in the server settings.
 *
 * @module provider/SkillInventory
 */
import {
  type ProjectId,
  type ProviderInstanceId,
  type SetSkillEnabledInput,
  type SetSkillHiddenInput,
  type SkillInventory as SkillInventoryData,
  type SkillInventorySkill,
  SkillToggleError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import * as ProviderInstanceRegistry from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";

export class SkillInventory extends Context.Service<
  SkillInventory,
  {
    /** Every skill each provider lists, across all projects and their worktrees. */
    readonly list: Effect.Effect<SkillInventoryData>;
    /**
     * Switch a listed skill on or off for the whole machine, then report the
     * inventory again. Plugin skills turn on and off with their plugin, so
     * they are refused.
     */
    readonly setEnabled: (
      input: SetSkillEnabledInput,
    ) => Effect.Effect<SkillInventoryData, SkillToggleError>;
    /**
     * Hide a listed skill and switch it off for the whole machine in every
     * provider that lists it, or show it again and switch it back on there,
     * then report the inventory again. Plugin copies are left as they are.
     */
    readonly setHidden: (
      input: SetSkillHiddenInput,
    ) => Effect.Effect<SkillInventoryData, SkillToggleError>;
  }
>()("t3/provider/SkillInventory") {}

/** The folders to list, and the projects each belongs to. */
type Folders = {
  readonly projectCount: number;
  readonly byCwd: ReadonlyMap<string, ReadonlySet<ProjectId>>;
};

/**
 * One entry per skill name, carrying the projects whose folders list it. A
 * skill counts as on when any folder has it on, since project settings can
 * hold one off that the user-wide switch turned on.
 */
function mergeFolderSkills(
  listed: ReadonlyMap<string, ReadonlyArray<SkillInventorySkill>>,
  folders: Folders,
): ReadonlyArray<SkillInventorySkill> {
  const byName = new Map<
    string,
    { readonly skill: SkillInventorySkill; readonly projects: Set<ProjectId>; enabled: boolean }
  >();
  for (const [cwd, skills] of listed) {
    const projects = folders.byCwd.get(cwd) ?? new Set<ProjectId>();
    for (const skill of skills) {
      const entry = byName.get(skill.name);
      if (entry === undefined) {
        byName.set(skill.name, { skill, projects: new Set(projects), enabled: skill.enabled });
        continue;
      }
      for (const project of projects) entry.projects.add(project);
      entry.enabled ||= skill.enabled;
    }
  }
  return Array.from(byName.values(), ({ skill, projects, enabled }) => {
    const { projectIds: _projectIds, ...rest } = skill;
    return {
      ...rest,
      enabled,
      ...(projects.size >= folders.projectCount ? {} : { projectIds: [...projects].toSorted() }),
    };
  }).toSorted((left, right) => left.name.localeCompare(right.name));
}

const make = Effect.gen(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const instanceRegistry = yield* ProviderInstanceRegistry.ProviderInstanceRegistry;
  const projectStore = yield* ProjectStore.ProjectStoreV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  // The last listing per instance, so a toggle relists only its own provider.
  const listedRef = yield* Ref.make<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<SkillInventorySkill>>
  >(new Map());
  // Listings and toggles run one at a time, so no reply reports skills older
  // than a reply sent before it, and a slow relisting never replaces a newer one.
  const semaphore = yield* Semaphore.make(1);

  const listFolders = Effect.gen(function* () {
    const projects = yield* projectStore.listShells().pipe(Effect.orElseSucceed(() => []));
    const worktrees = yield* sql<{ readonly projectId: string; readonly worktreePath: string }>`
      SELECT DISTINCT
        project_id AS "projectId",
        json_extract(payload_json, '$.worktreePath') AS "worktreePath"
      FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND archived_at IS NULL
        AND json_extract(payload_json, '$.worktreePath') IS NOT NULL
    `.pipe(Effect.orElseSucceed(() => []));
    const projectIds = new Set(projects.map((project) => project.id));
    const byCwd = new Map<string, Set<ProjectId>>();
    const add = (cwd: string, projectId: ProjectId) => {
      const owners = byCwd.get(cwd) ?? new Set<ProjectId>();
      owners.add(projectId);
      byCwd.set(cwd, owners);
    };
    for (const project of projects) add(project.workspaceRoot, project.id);
    for (const worktree of worktrees) {
      const owner = projects.find((project) => project.id === worktree.projectId);
      if (owner !== undefined) add(worktree.worktreePath, owner.id);
    }
    return { projectCount: projectIds.size, byCwd } satisfies Folders;
  });

  /** Enabled, installed providers whose driver can list its skills. */
  const listingInstances = Effect.gen(function* () {
    const providers = yield* providerRegistry.getProviders;
    const instances: Array<ProviderInstance> = [];
    for (const provider of providers) {
      if (!provider.enabled || !provider.installed) continue;
      const instance = yield* instanceRegistry.getInstance(provider.instanceId);
      if (instance?.listSkills !== undefined) instances.push(instance);
    }
    return instances;
  });

  const listInstance = (
    instance: ProviderInstance,
    folders: Folders,
  ): Effect.Effect<ReadonlyArray<SkillInventorySkill>> =>
    instance.listSkills === undefined
      ? Effect.succeed([])
      : instance.listSkills({ cwds: [...folders.byCwd.keys()] }).pipe(
          Effect.map((listed) => mergeFolderSkills(listed, folders)),
          Effect.catch((cause) =>
            Effect.logWarning("could not list provider skills", {
              instanceId: instance.instanceId,
              cause,
            }).pipe(Effect.as([])),
          ),
        );

  const report = (instances: ReadonlyArray<ProviderInstance>) =>
    Effect.gen(function* () {
      const listed = yield* Ref.get(listedRef);
      const settings = yield* serverSettings.getSettings.pipe(Effect.option);
      return {
        providers: instances.map((instance) => ({
          instanceId: instance.instanceId,
          skills: listed.get(instance.instanceId) ?? [],
        })),
        hiddenSkills: Option.match(settings, {
          onNone: () => [],
          onSome: (current) => current.hiddenSkills,
        }),
      } satisfies SkillInventoryData;
    });

  const list: SkillInventory["Service"]["list"] = Effect.gen(function* () {
    const [instances, folders] = yield* Effect.all([listingInstances, listFolders]);
    const listed = yield* Effect.forEach(
      instances,
      (instance) =>
        listInstance(instance, folders).pipe(
          Effect.map((skills) => [instance.instanceId, skills] as const),
        ),
      { concurrency: "unbounded" },
    );
    yield* Ref.set(listedRef, new Map(listed));
    return yield* report(instances);
  }).pipe(semaphore.withPermits(1));

  const setEnabled: SkillInventory["Service"]["setEnabled"] = (input) =>
    Effect.gen(function* () {
      const instances = yield* listingInstances;
      const instance = instances.find((candidate) => candidate.instanceId === input.instanceId);
      if (instance === undefined) {
        return yield* new SkillToggleError({
          detail: "This provider cannot switch skills on and off.",
        });
      }
      const known = (yield* Ref.get(listedRef)).get(instance.instanceId);
      const skills = known ?? (yield* listInstance(instance, yield* listFolders));
      // The name comes from this server's own listing, never straight from a client.
      const skill = skills.find((candidate) => candidate.name === input.skillName);
      if (skill === undefined) {
        return yield* new SkillToggleError({ detail: `No skill named ${input.skillName}.` });
      }
      if (skill.plugin !== undefined) {
        return yield* new SkillToggleError({
          detail: `${skill.name} turns on and off with the ${skill.plugin} plugin.`,
        });
      }
      yield* providerRegistry.setSkillEnabled(input);
      const relisted = yield* listInstance(instance, yield* listFolders);
      yield* Ref.update(listedRef, (listed) => new Map(listed).set(instance.instanceId, relisted));
      return yield* report(instances);
    }).pipe(semaphore.withPermits(1));

  const setHidden: SkillInventory["Service"]["setHidden"] = (input) =>
    Effect.gen(function* () {
      const [instances, folders] = yield* Effect.all([listingInstances, listFolders]);
      const known = yield* Ref.get(listedRef);
      const listings = yield* Effect.forEach(instances, (instance) => {
        const cached = known.get(instance.instanceId);
        return (
          cached === undefined ? listInstance(instance, folders) : Effect.succeed(cached)
        ).pipe(
          Effect.map((skills) => ({
            instance,
            skill: skills.find((candidate) => candidate.name === input.skillName),
          })),
        );
      });
      const listing = listings.filter((entry) => entry.skill !== undefined);
      // The name comes from this server's own listing; one no provider lists
      // any more can still be shown again.
      if (input.hidden && listing.length === 0) {
        return yield* new SkillToggleError({ detail: `No skill named ${input.skillName}.` });
      }
      // The switch is user-wide; the folder only says where the provider runs.
      const [cwd] = folders.byCwd.keys();
      for (const { instance, skill } of listing) {
        if (cwd === undefined || skill?.plugin !== undefined) continue;
        if (instance.setSkillEnabled === undefined) continue;
        yield* providerRegistry.setSkillEnabled({
          instanceId: instance.instanceId,
          cwd,
          skillName: input.skillName,
          enabled: !input.hidden,
        });
      }
      const current = yield* serverSettings.getSettings;
      const others = current.hiddenSkills.filter((name) => name !== input.skillName);
      yield* serverSettings.updateSettings({
        hiddenSkills: input.hidden ? [...others, input.skillName] : others,
      });
      const relisted = yield* Effect.forEach(
        listing,
        ({ instance }) =>
          listInstance(instance, folders).pipe(
            Effect.map((skills) => [instance.instanceId, skills] as const),
          ),
        { concurrency: "unbounded" },
      );
      yield* Ref.update(listedRef, (listed) => new Map([...listed, ...relisted]));
      return yield* report(instances);
    }).pipe(
      Effect.catchTag("ServerSettingsError", (cause) =>
        Effect.fail(new SkillToggleError({ detail: "Could not save the hidden skills.", cause })),
      ),
      semaphore.withPermits(1),
    );

  return SkillInventory.of({ list, setEnabled, setHidden });
});

export const layer = Layer.effect(SkillInventory, make);
