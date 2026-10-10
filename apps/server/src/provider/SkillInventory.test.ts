import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationProjectShell,
  type ServerProvider,
  type SkillInventorySkill,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { ProviderInstance } from "./ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "./providerMaintenance.ts";
import * as ProviderInstanceRegistry from "./Services/ProviderInstanceRegistry.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import * as SkillInventory from "./SkillInventory.ts";

const driver = ProviderDriverKind.make("claudeAgent");
const instanceId = ProviderInstanceId.make("claudeAgent");
const projectA = ProjectId.make("project-a");
const projectB = ProjectId.make("project-b");

const provider = {
  instanceId,
  driver,
  status: "ready",
  enabled: true,
  installed: true,
  auth: { status: "authenticated" },
  checkedAt: "2026-10-10T00:00:00.000Z",
  version: "1.0.0",
  models: [],
  slashCommands: [],
  skills: [],
} as const satisfies ServerProvider;

const project = (id: ProjectId, workspaceRoot: string): OrchestrationProjectShell => ({
  id,
  title: id,
  workspaceRoot,
  defaultModelSelection: null,
  scripts: [],
  createdAt: "2026-10-10T00:00:00.000Z",
  updatedAt: "2026-10-10T00:00:00.000Z",
});

const skill = (name: string, extra: Partial<SkillInventorySkill> = {}): SkillInventorySkill => ({
  name,
  path: `/skills/${name}/SKILL.md`,
  enabled: true,
  scope: "project",
  ...extra,
});

/**
 * A provider whose skills per folder live in `disk`, a registry whose toggle
 * switches a name off or on in every folder, and two projects: A at `/a`
 * with a worktree at `/a-worktree`, and B at `/b`.
 */
const makeHarness = (initial: Record<string, ReadonlyArray<SkillInventorySkill>>) =>
  Effect.gen(function* () {
    const disk = yield* Ref.make(initial);
    const listedCwds = yield* Ref.make<ReadonlyArray<string>>([]);
    const instance: ProviderInstance = {
      instanceId,
      driverKind: driver,
      continuationIdentity: { driverKind: driver, continuationKey: "claude:instance" },
      displayName: undefined,
      enabled: true,
      snapshot: {
        resolveMaintenance: () =>
          Effect.succeed(
            makeManualOnlyProviderMaintenanceCapabilities({ provider: driver, packageName: null }),
          ),
        getSnapshot: Effect.succeed(provider),
        refresh: Effect.succeed(provider),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      },
      listSkills: ({ cwds }) =>
        Ref.set(listedCwds, cwds).pipe(
          Effect.andThen(Ref.get(disk)),
          Effect.map(
            (folders) =>
              new Map(cwds.flatMap((cwd) => (folders[cwd] ? [[cwd, folders[cwd]] as const] : []))),
          ),
        ),
      // The registry mock below does the switching.
      setSkillEnabled: () => Effect.succeed(new Map()),
      orchestrationAdapter: {} as ProviderInstance["orchestrationAdapter"],
      textGeneration: {} as ProviderInstance["textGeneration"],
    };
    const dependencies = Layer.mergeAll(
      Layer.mock(ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        setSkillEnabled: (input) =>
          Ref.update(disk, (folders) =>
            Object.fromEntries(
              Object.entries(folders).map(([cwd, skills]) => [
                cwd,
                skills.map((entry) =>
                  entry.name === input.skillName ? { ...entry, enabled: input.enabled } : entry,
                ),
              ]),
            ),
          ).pipe(Effect.as([provider])),
      }),
      Layer.mock(ProviderInstanceRegistry.ProviderInstanceRegistry)({
        getInstance: (requested) => Effect.succeed(requested === instanceId ? instance : undefined),
      }),
      Layer.mock(ProjectStore.ProjectStoreV2)({
        listShells: () => Effect.succeed([project(projectA, "/a"), project(projectB, "/b")]),
      }),
      ServerSettings.layerTest(),
      SqlitePersistenceMemory,
    );
    const context = yield* Layer.build(SkillInventory.layer.pipe(Layer.provideMerge(dependencies)));
    const sql = yield* SqlClient.SqlClient.pipe(Effect.provide(context));
    const addThread = (threadId: string, worktreePath: string, archivedAt: string | null) =>
      sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          created_at, updated_at, archived_at, payload_json
        ) VALUES (
          ${threadId}, ${projectA}, 'Thread', 'claudeAgent', 'full-access', 'default',
          '2026-10-10T00:00:00.000Z', '2026-10-10T00:00:00.000Z', ${archivedAt},
          ${JSON.stringify({ worktreePath })}
        )
      `;
    yield* addThread("thread-active", "/a-worktree", null);
    yield* addThread("thread-archived", "/archived-worktree", "2026-10-10T00:00:00.000Z");
    const inventory = yield* SkillInventory.SkillInventory.pipe(Effect.provide(context));
    return { inventory, listedCwds };
  });

const summarize = (skills: ReadonlyArray<SkillInventorySkill> | undefined) =>
  (skills ?? []).map(
    (entry) =>
      `${entry.name} ${entry.enabled ? "on" : "off"} ${entry.projectIds?.join(",") ?? "everywhere"}`,
  );

it.effect("lists each skill once, with the projects whose folders load it", () =>
  Effect.gen(function* () {
    const { inventory, listedCwds } = yield* makeHarness({
      "/a": [skill("user-skill", { scope: "user" }), skill("repo-a")],
      "/b": [skill("user-skill", { scope: "user" }), skill("repo-b")],
      "/a-worktree": [skill("user-skill", { scope: "user" }), skill("worktree-only")],
    });

    const listed = yield* inventory.list;

    // Archived threads' worktrees are not listed.
    assert.deepStrictEqual(yield* Ref.get(listedCwds), ["/a", "/b", "/a-worktree"]);
    assert.deepStrictEqual(summarize(listed.providers[0]?.skills), [
      "repo-a on project-a",
      "repo-b on project-b",
      "user-skill on everywhere",
      "worktree-only on project-a",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("switches a listed skill everywhere, and refuses plugin and unknown skills", () =>
  Effect.gen(function* () {
    const { inventory } = yield* makeHarness({
      "/a": [skill("review"), skill("tools:lint", { scope: "plugin", plugin: "tools" })],
      "/b": [skill("review")],
    });
    yield* inventory.list;

    const pluginError = yield* Effect.flip(
      inventory.setEnabled({ instanceId, cwd: "/a", skillName: "tools:lint", enabled: false }),
    );
    assert.match(pluginError.detail, /with the tools plugin/);
    const unknownError = yield* Effect.flip(
      inventory.setEnabled({ instanceId, cwd: "/a", skillName: "missing", enabled: false }),
    );
    assert.match(unknownError.detail, /No skill named missing/);

    const answered = yield* inventory.setEnabled({
      instanceId,
      cwd: "/a",
      skillName: "review",
      enabled: false,
    });
    assert.deepStrictEqual(summarize(answered.providers[0]?.skills), [
      "review off everywhere",
      "tools:lint on project-a",
    ]);
  }).pipe(Effect.scoped),
);

it.effect("hides a skill by switching it off, and shows it again by switching it on", () =>
  Effect.gen(function* () {
    const { inventory } = yield* makeHarness({
      "/a": [skill("review"), skill("deploy"), skill("tools:lint", { plugin: "tools" })],
    });
    yield* inventory.list;

    const hidden = yield* inventory.setHidden({ skillName: "review", hidden: true });
    assert.deepStrictEqual(hidden.hiddenSkills, ["review"]);
    assert.deepStrictEqual(summarize(hidden.providers[0]?.skills), [
      "deploy on project-a",
      "review off project-a",
      "tools:lint on project-a",
    ]);

    // A plugin skill is hidden but left on: it switches with its plugin.
    const plugin = yield* inventory.setHidden({ skillName: "tools:lint", hidden: true });
    assert.deepStrictEqual(plugin.hiddenSkills, ["review", "tools:lint"]);
    assert.include(summarize(plugin.providers[0]?.skills), "tools:lint on project-a");

    const shown = yield* inventory.setHidden({ skillName: "review", hidden: false });
    assert.deepStrictEqual(shown.hiddenSkills, ["tools:lint"]);
    assert.include(summarize(shown.providers[0]?.skills), "review on project-a");
    // The list survives into the next report.
    assert.deepStrictEqual((yield* inventory.list).hiddenSkills, ["tools:lint"]);

    const unknownError = yield* Effect.flip(
      inventory.setHidden({ skillName: "missing", hidden: true }),
    );
    assert.match(unknownError.detail, /No skill named missing/);
  }).pipe(Effect.scoped),
);
