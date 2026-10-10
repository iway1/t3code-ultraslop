/**
 * ClaudeSkills — filesystem discovery of Claude Code skills.
 *
 * `discoverClaudeSkills` feeds the `$` picker from `<config dir>/skills` (user
 * scope) and `<cwd>/.claude/skills` (project scope), one directory per skill
 * with a `SKILL.md` carrying YAML frontmatter. `listClaudeSkills` feeds the
 * Skill Monitor from every source the CLI reads. The user root wins on name
 * collisions, matching the CLI. `.agents/skills` is a Codex location: verified
 * against the CLI, a skill that lives only there is answered with `Unknown
 * command`, so it is not scanned here.
 * The Agent SDK init handshake surfaces skills only as slash commands without
 * their filesystem paths, so the provider snapshot scans the same locations
 * directly, mirroring how the Codex app-server reports its skills.
 *
 * @module provider/Drivers/ClaudeSkills
 */
import * as NodeOS from "node:os";

import type { ClaudeSettings, ServerProviderSkill, SkillInventorySkill } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import { parse as parseYamlDocument } from "yaml";

import { writeFileStringAtomically } from "../../atomicWrite.ts";
import { expandHomePath } from "../../pathExpansion.ts";
import { spawnAndCollect } from "../providerSnapshot.ts";

type ClaudeSkillScope = "user" | "project";

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

type SkillFrontmatter =
  | { readonly kind: "missing" }
  | { readonly kind: "malformed" }
  | {
      readonly kind: "parsed";
      readonly description?: string;
      readonly userInvocationOnly?: boolean;
      readonly userInvocable?: boolean;
    };

/**
 * Claude Code accepts the YAML 1.1 boolean spellings (`yes`/`no`, `on`/`off`,
 * `1`/`0`), which the 1.2 core schema this parser uses leaves as strings and
 * numbers. Verified against the CLI: a skill carrying `user-invocable: no` is
 * absent from its published slash commands, so a strict `=== false` here would
 * offer a command the CLI rejects.
 */
function parseFrontmatterBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    return value === 1 ? true : value === 0 ? false : undefined;
  }
  if (typeof value !== "string") return undefined;
  switch (value.trim().toLowerCase()) {
    case "true":
    case "yes":
    case "on":
    case "y":
      return true;
    case "false":
    case "no":
    case "off":
    case "n":
      return false;
    default:
      return undefined;
  }
}

function parseSkillFrontmatter(contents: string): SkillFrontmatter {
  const match = FRONTMATTER_PATTERN.exec(contents);
  if (!match) {
    return { kind: "missing" };
  }

  let parsed: unknown;
  try {
    parsed = parseYamlDocument(match[1] ?? "");
  } catch {
    return { kind: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "malformed" };
  }

  const record = parsed as Record<string, unknown>;
  const description = typeof record.description === "string" ? record.description.trim() : "";
  return {
    kind: "parsed",
    ...(description ? { description } : {}),
    ...(parseFrontmatterBoolean(record["disable-model-invocation"]) === true
      ? { userInvocationOnly: true }
      : {}),
    ...(parseFrontmatterBoolean(record["user-invocable"]) === false
      ? { userInvocable: false }
      : {}),
  };
}

/**
 * Where an administrator installs the policy file whose settings outrank every
 * user and project one. Absent on almost every machine, which is why a missing
 * file is the normal case rather than an error.
 */
function claudeManagedSettingsPath(
  path: Path.Path,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
): string | undefined {
  if (platform === "darwin") {
    return "/Library/Application Support/ClaudeCode/managed-settings.json";
  }
  if (platform === "win32") {
    const programData = environment.PROGRAMDATA?.trim();
    return programData ? path.join(programData, "ClaudeCode", "managed-settings.json") : undefined;
  }
  return "/etc/claude-code/managed-settings.json";
}

/**
 * Settings files Claude Code merges for `skillOverrides`, in increasing
 * precedence: user, project, project-local, then the administrator's managed
 * policy, which wins outright. When the workspace sits inside a git
 * repository, the repository root's `settings.local.json` is read too and
 * outranks the workspace's own local file. Verified against the CLI from a
 * nested cwd: a root local file switching a skill off wins over a cwd one
 * switching it on, the root's plain `settings.json` is not consulted, and
 * without a `.git` above the cwd no root file is read. A skill the user
 * switched off is reported disabled rather than dropped, so the picker can
 * grey it out instead of silently losing it.
 */
export function skillOverrideSettingsPaths(
  path: Path.Path,
  configDirPath: string,
  cwd: string | undefined,
  platform: NodeJS.Platform,
  environment: NodeJS.ProcessEnv,
  repositoryRoot?: string,
): ReadonlyArray<string> {
  const managedPath = claudeManagedSettingsPath(path, platform, environment);
  const root = repositoryRoot !== undefined && repositoryRoot !== cwd ? repositoryRoot : undefined;
  return [
    path.join(configDirPath, "settings.json"),
    ...(cwd
      ? [
          path.join(cwd, ".claude", "settings.json"),
          path.join(cwd, ".claude", "settings.local.json"),
        ]
      : []),
    ...(root ? [path.join(root, ".claude", "settings.local.json")] : []),
    ...(managedPath ? [managedPath] : []),
  ];
}

/**
 * Nearest ancestor of `cwd` (inclusive) holding a `.git` entry, which is the
 * boundary Claude Code walks up to for project settings. `undefined` outside
 * a repository.
 */
const findRepositoryRoot = Effect.fn("findRepositoryRoot")(function* (
  cwd: string,
): Effect.fn.Return<string | undefined, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let current = path.resolve(cwd);
  while (true) {
    const isRoot = yield* fileSystem
      .exists(path.join(current, ".git"))
      .pipe(Effect.orElseSucceed(() => false));
    if (isRoot) {
      return current;
    }
    const parent = path.dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
});

/**
 * The four states Claude Code accepts. The CLI validates the whole map, not
 * each entry: verified against it, one entry with an unknown value (or a
 * boolean) makes it drop every override in that file, so this schema does the
 * same rather than applying the valid siblings the CLI ignores.
 */
const SkillOverrideValue = Schema.Literals(["on", "name-only", "user-invocable-only", "off"]);

// Lenient because these settings files are hand-edited and Claude Code itself
// tolerates comments and trailing commas in them.
const SkillOverrideSettings = fromLenientJson(
  Schema.Struct({
    skillOverrides: Schema.optional(Schema.Record(Schema.String, SkillOverrideValue)),
  }),
);
const decodeSkillOverrideSettings = Schema.decodeUnknownEffect(SkillOverrideSettings);

/**
 * What a `skillOverrides` entry says about one skill. `"user-invocable-only"`
 * hides it from the agent exactly as `disable-model-invocation` does, so it is
 * kept apart from a plain on/off decision rather than collapsed into one.
 */
type SkillOverride = {
  readonly enabled: boolean;
  readonly userInvocationOnly: boolean;
};

function parseSkillOverride(value: typeof SkillOverrideValue.Type): SkillOverride {
  switch (value) {
    case "off":
      return { enabled: false, userInvocationOnly: false };
    case "user-invocable-only":
      return { enabled: true, userInvocationOnly: true };
    case "on":
    case "name-only":
      return { enabled: true, userInvocationOnly: false };
  }
}

// Read apart from `skillOverrides` so a malformed plugin map, which the CLI
// rejects on its own, cannot take the overrides down with it.
const PluginSettings = fromLenientJson(
  Schema.Struct({
    enabledPlugins: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
);
const decodePluginSettings = Schema.decodeUnknownEffect(PluginSettings);

/**
 * The `skillOverrides` and `enabledPlugins` Claude Code applies in `cwd`,
 * merged across the same settings files in the same precedence.
 */
const readSkillSettings = Effect.fn("readSkillSettings")(function* (
  configDirPath: string,
  cwd: string | undefined,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<
  {
    readonly overrides: ReadonlyMap<string, SkillOverride>;
    readonly plugins: ReadonlyMap<string, boolean>;
  },
  never,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcessPlatform;
  const overridesByName = new Map<string, SkillOverride>();
  const pluginsByKey = new Map<string, boolean>();
  const repositoryRoot = cwd === undefined ? undefined : yield* findRepositoryRoot(cwd);

  for (const settingsPath of skillOverrideSettingsPaths(
    path,
    configDirPath,
    cwd,
    platform,
    environment,
    repositoryRoot,
  )) {
    const contents = yield* fileSystem
      .readFileString(settingsPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }

    const plugins = yield* decodePluginSettings(contents).pipe(
      Effect.orElseSucceed(() => undefined),
    );
    for (const [key, value] of Object.entries(plugins?.enabledPlugins ?? {})) {
      if (typeof value === "boolean") pluginsByKey.set(key, value);
    }

    const parsed = yield* decodeSkillOverrideSettings(contents).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("claude settings file is unreadable; ignoring skillOverrides", {
          path: settingsPath,
          cause,
        }),
      ),
      Effect.orElseSucceed(() => undefined),
    );
    const overrides = parsed?.skillOverrides;
    if (!overrides) {
      continue;
    }

    for (const [name, value] of Object.entries(overrides)) {
      overridesByName.set(name, parseSkillOverride(value));
    }
  }

  return { overrides: overridesByName, plugins: pluginsByKey };
});

/**
 * Resolve the Claude config directory the CLI would use, matching the
 * precedence the spawned CLI sees: the instance's `homePath` (exported as
 * `CLAUDE_CONFIG_DIR` by `makeClaudeEnvironment`), then a `CLAUDE_CONFIG_DIR`
 * already present in the process environment, then `~/.claude`.
 */
const resolveClaudeConfigDirPath = Effect.fn("resolveClaudeConfigDirPath")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  environment: NodeJS.ProcessEnv,
  cwd?: string,
): Effect.fn.Return<string, never, Path.Path> {
  const path = yield* Path.Path;
  const homePath = config.homePath.trim();
  if (homePath.length > 0) {
    return path.resolve(expandHomePath(homePath));
  }
  // No tilde expansion here: the spawned CLI receives this env var verbatim
  // (env vars are never shell-expanded), so a literal `~` must stay literal
  // for discovery to scan the same directory the runtime would. A relative
  // value is resolved against the workspace cwd — the subprocess's own cwd —
  // for the same reason.
  const environmentConfigDir = environment.CLAUDE_CONFIG_DIR?.trim() ?? "";
  if (environmentConfigDir.length > 0) {
    return cwd ? path.resolve(cwd, environmentConfigDir) : path.resolve(environmentConfigDir);
  }
  return path.join(NodeOS.homedir(), ".claude");
});

type SkillFile = {
  readonly name: string;
  readonly path: string;
  readonly frontmatter: Exclude<SkillFrontmatter, { readonly kind: "malformed" }>;
};

/**
 * The skills in one `skills` folder, one subfolder each. Unreadable folders
 * and entries are skipped so a broken skill never degrades a listing.
 */
const readSkillDirectory = Effect.fn("readSkillDirectory")(function* (
  directory: string,
): Effect.fn.Return<ReadonlyArray<SkillFile>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(directory)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  const files: Array<SkillFile> = [];
  for (const entry of [...entries].sort()) {
    // Claude Code identifies a skill by its directory, not by the
    // frontmatter `name`: verified against the CLI, a skill in `probe-alias/`
    // declaring `name: probe-alias-frontmatter` is published as
    // `probe-alias`, and only `skillOverrides["probe-alias"]` switches it
    // off. Keying off the frontmatter name would report a command that does
    // not exist and miss the override that disables it.
    const name = entry.trim();
    if (!name) {
      continue;
    }
    const skillPath = path.join(directory, entry, "SKILL.md");
    const contents = yield* fileSystem
      .readFileString(skillPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (contents === undefined) {
      continue;
    }
    const frontmatter = parseSkillFrontmatter(contents);
    // Malformed frontmatter means the skill won't load in Claude Code
    // either — skip it rather than surfacing a broken entry under its
    // directory name.
    if (frontmatter.kind === "malformed") {
      continue;
    }
    files.push({ name, path: skillPath, frontmatter });
  }
  return files;
});

function skillFromFile(
  file: SkillFile,
  scope: string,
  override: SkillOverride | undefined,
  name = file.name,
): ServerProviderSkill {
  const parsed = file.frontmatter.kind === "parsed" ? file.frontmatter : undefined;
  const userInvocationOnly =
    parsed?.userInvocationOnly === true || override?.userInvocationOnly === true;
  return {
    name,
    path: file.path,
    enabled: override?.enabled ?? true,
    scope,
    ...(parsed?.description ? { description: parsed.description } : {}),
    ...(userInvocationOnly ? { userInvocationOnly: true } : {}),
    ...(parsed?.userInvocable === false ? { userInvocable: false } : {}),
  };
}

/**
 * Enumerate Claude Code skills from the user config dir and the workspace
 * `.claude/skills`, for the `$` picker. Roots are listed highest precedence
 * first and the first hit for a name wins, matching Claude Code: verified
 * against the CLI with the same skill name in both scopes, the user copy is
 * the one that runs. Reporting the project copy instead would attach its
 * invocation metadata to a command Claude Code resolves elsewhere.
 */
export const discoverClaudeSkills = Effect.fn("discoverClaudeSkills")(function* (
  config: Pick<ClaudeSettings, "homePath">,
  cwd?: string,
  environment?: NodeJS.ProcessEnv,
): Effect.fn.Return<ReadonlyArray<ServerProviderSkill>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(config, environment ?? process.env, cwd);
  const { overrides } = yield* readSkillSettings(configDirPath, cwd, environment ?? process.env);

  const roots: ReadonlyArray<{ directory: string; scope: ClaudeSkillScope }> = [
    { directory: path.join(configDirPath, "skills"), scope: "user" },
    ...(cwd ? [{ directory: path.join(cwd, ".claude", "skills"), scope: "project" as const }] : []),
  ];

  const skillsByName = new Map<string, ServerProviderSkill>();
  for (const root of roots) {
    for (const file of yield* readSkillDirectory(root.directory)) {
      // First root wins, so a later root never displaces a higher-precedence
      // skill of the same name.
      if (!skillsByName.has(file.name)) {
        skillsByName.set(file.name, skillFromFile(file, root.scope, overrides.get(file.name)));
      }
    }
  }

  return [...skillsByName.values()].sort((left, right) => left.name.localeCompare(right.name));
});

/** Bounds the nested-folder search outside a git repository. */
const NESTED_WALK_MAX_DEPTH = 3;
const NESTED_WALK_MAX_FOLDERS = 1_000;

/**
 * `.claude/skills` folders nested below `cwd`, which Claude Code loads once
 * the agent works on a file there (verified against the CLI). Inside a
 * repository git's index answers without walking ignored folders; elsewhere a
 * bounded walk does.
 */
const findNestedSkillRoots = Effect.fn("findNestedSkillRoots")(function* (
  cwd: string,
): Effect.fn.Return<
  ReadonlyArray<string>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const path = yield* Path.Path;
  const own = path.join(cwd, ".claude", "skills");
  const listed = yield* spawnAndCollect(
    "git",
    ChildProcess.make(
      "git",
      [
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
        "--",
        ":(glob)**/.claude/skills/*/SKILL.md",
      ],
      { cwd, env: { GIT_OPTIONAL_LOCKS: "0" }, extendEnv: true },
    ),
  ).pipe(Effect.orElseSucceed(() => undefined));
  if (listed !== undefined && listed.code === 0) {
    const roots = new Set<string>();
    for (const file of listed.stdout.split("\0")) {
      if (!file) continue;
      const root = path.join(cwd, path.dirname(path.dirname(file)));
      if (root !== own) roots.add(root);
    }
    return [...roots];
  }
  return yield* walkForSkillRoots(cwd);
});

const walkForSkillRoots = Effect.fn("walkForSkillRoots")(function* (
  cwd: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const roots: Array<string> = [];
  let level: ReadonlyArray<string> = [cwd];
  let visited = 0;
  for (let depth = 0; depth <= NESTED_WALK_MAX_DEPTH && level.length > 0; depth += 1) {
    const next: Array<string> = [];
    for (const folder of level) {
      if (visited >= NESTED_WALK_MAX_FOLDERS) return roots;
      visited += 1;
      const entries = yield* fileSystem
        .readDirectory(folder)
        .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
      if (folder !== cwd && entries.includes(".claude")) {
        roots.push(path.join(folder, ".claude", "skills"));
      }
      for (const entry of entries) {
        if (entry.startsWith(".") || entry === "node_modules") continue;
        next.push(path.join(folder, entry));
      }
    }
    level = next;
  }
  return roots;
});

/**
 * `.claude/skills` in `cwd` and each folder above it, nearest first: up to the
 * repository root inside one, or to the filesystem root outside (verified
 * against the CLI). The user's own skills folder is left out; it is user scope.
 */
const findProjectSkillRoots = Effect.fn("findProjectSkillRoots")(function* (
  cwd: string,
  userSkillsDirectory: string,
): Effect.fn.Return<ReadonlyArray<string>, never, FileSystem.FileSystem | Path.Path> {
  const path = yield* Path.Path;
  const repositoryRoot = yield* findRepositoryRoot(cwd);
  const roots: Array<string> = [];
  let current = path.resolve(cwd);
  while (true) {
    const root = path.join(current, ".claude", "skills");
    if (root !== userSkillsDirectory) roots.push(root);
    const parent = path.dirname(current);
    if (current === repositoryRoot || parent === current) return roots;
    current = parent;
  }
});

const InstalledPlugins = fromLenientJson(
  Schema.Struct({
    plugins: Schema.optional(
      Schema.Record(
        Schema.String,
        Schema.Array(
          Schema.Struct({
            installPath: Schema.String,
            lastUpdated: Schema.optional(Schema.String),
          }),
        ),
      ),
    ),
  }),
);
const decodeInstalledPlugins = Schema.decodeUnknownEffect(InstalledPlugins);

const PluginManifest = fromLenientJson(
  Schema.Struct({
    name: Schema.optional(Schema.String),
    skills: Schema.optional(Schema.Union([Schema.String, Schema.Array(Schema.String)])),
  }),
);
const decodePluginManifest = Schema.decodeUnknownEffect(PluginManifest);

type InstalledPlugin = {
  /** `<plugin>@<marketplace>`, as `enabledPlugins` keys it. */
  readonly key: string;
  readonly name: string;
  readonly skills: ReadonlyArray<SkillFile>;
};

/**
 * Every installed plugin and the skills it ships, from the CLI's own install
 * record. Its skills sit in `skills/` under the install, plus any folders its
 * manifest names.
 */
const readInstalledPlugins = Effect.fn("readInstalledPlugins")(function* (
  configDirPath: string,
): Effect.fn.Return<ReadonlyArray<InstalledPlugin>, never, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const installed = yield* fileSystem
    .readFileString(path.join(configDirPath, "plugins", "installed_plugins.json"))
    .pipe(
      Effect.flatMap((contents) => decodeInstalledPlugins(contents)),
      Effect.orElseSucceed(() => undefined),
    );
  const plugins: Array<InstalledPlugin> = [];
  for (const [key, records] of Object.entries(installed?.plugins ?? {})) {
    const latest = records.toSorted((left, right) =>
      (right.lastUpdated ?? "").localeCompare(left.lastUpdated ?? ""),
    )[0];
    if (latest === undefined) continue;
    const manifest = yield* fileSystem
      .readFileString(path.join(latest.installPath, ".claude-plugin", "plugin.json"))
      .pipe(
        Effect.flatMap((contents) => decodePluginManifest(contents)),
        Effect.orElseSucceed(() => undefined),
      );
    const extra = manifest?.skills === undefined ? [] : [manifest.skills].flat();
    const skills = new Map<string, SkillFile>();
    for (const root of [
      path.join(latest.installPath, "skills"),
      ...extra.map((folder) => path.resolve(latest.installPath, folder)),
    ]) {
      for (const file of yield* readSkillDirectory(root)) {
        if (!skills.has(file.name)) skills.set(file.name, file);
      }
    }
    const name = manifest?.name?.trim() || key.split("@")[0]?.trim() || key;
    plugins.push({ key, name, skills: [...skills.values()] });
  }
  return plugins;
});

/**
 * Every Claude Code skill each of `cwds` can load, switched on or not, found
 * the way the CLI finds them (verified against it):
 * - user skills in `<config dir>/skills`, and skills synced from claude.ai in
 *   `<config dir>/skills/synced/<account>/`;
 * - project skills in `.claude/skills` of the cwd and the folders above it,
 *   and in folders nested below it;
 * - skills of installed plugins, named `<plugin>:<skill>`, which turn on and
 *   off with their plugin, so they carry `plugin`. A plugin is listed where it
 *   is enabled, or everywhere when it is enabled nowhere;
 * - `builtIns`, which only the CLI knows. A switched-off skill drops out of
 *   its list, so a `skillOverrides` entry nothing else claims is reported as
 *   a switched-off built-in rather than lost.
 * `skillOverrides` switches every kind but plugin skills.
 */
export const listClaudeSkills = Effect.fn("listClaudeSkills")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly cwds: ReadonlyArray<string>;
  readonly environment: NodeJS.ProcessEnv;
  readonly builtIns: ReadonlyArray<{ readonly name: string; readonly description?: string }>;
  /** Synced skills the CLI reported as `anthropic-skills:<name>`, by bare name. */
  readonly namespacedSynced: ReadonlySet<string>;
}): Effect.fn.Return<
  ReadonlyMap<string, ReadonlyArray<SkillInventorySkill>>,
  never,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const configDirPath = yield* resolveClaudeConfigDirPath(input.config, input.environment);
  const userSkillsDirectory = path.join(configDirPath, "skills");
  const userSkills = yield* readSkillDirectory(userSkillsDirectory);
  const syncedRoot = path.join(userSkillsDirectory, "synced");
  const syncedSkills = (yield* Effect.forEach(
    yield* fileSystem
      .readDirectory(syncedRoot)
      .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => [])),
    (account) => readSkillDirectory(path.join(syncedRoot, account)),
  )).flat();
  const plugins = yield* readInstalledPlugins(configDirPath);

  const folders = yield* Effect.forEach(
    input.cwds,
    (cwd) =>
      Effect.all({
        settings: readSkillSettings(configDirPath, cwd, input.environment),
        projectRoots: findProjectSkillRoots(cwd, userSkillsDirectory),
        nestedRoots: findNestedSkillRoots(cwd),
      }).pipe(Effect.map((found) => ({ cwd, ...found }))),
    { concurrency: "unbounded" },
  );
  const pluginEnabledSomewhere = new Set(
    plugins
      .filter((plugin) =>
        folders.some((folder) => folder.settings.plugins.get(plugin.key) === true),
      )
      .map((plugin) => plugin.key),
  );

  const listed = new Map<string, ReadonlyArray<SkillInventorySkill>>();
  for (const folder of folders) {
    const { overrides, plugins: pluginStates } = folder.settings;
    const skills = new Map<string, SkillInventorySkill>();
    const add = (skill: SkillInventorySkill) => {
      if (!skills.has(skill.name)) skills.set(skill.name, skill);
    };
    for (const file of userSkills) add(skillFromFile(file, "user", overrides.get(file.name)));
    for (const file of syncedSkills) {
      const name = input.namespacedSynced.has(file.name)
        ? `anthropic-skills:${file.name}`
        : file.name;
      add(skillFromFile(file, "synced", overrides.get(name), name));
    }
    for (const root of [...folder.projectRoots, ...folder.nestedRoots]) {
      for (const file of yield* readSkillDirectory(root)) {
        add(skillFromFile(file, "project", overrides.get(file.name)));
      }
    }
    for (const plugin of plugins) {
      const enabled = pluginStates.get(plugin.key) === true;
      if (!enabled && pluginEnabledSomewhere.has(plugin.key)) continue;
      for (const file of plugin.skills) {
        add({
          ...skillFromFile(file, "plugin", undefined, `${plugin.name}:${file.name}`),
          enabled,
          plugin: plugin.name,
        });
      }
    }
    for (const builtIn of input.builtIns) {
      add({
        name: builtIn.name,
        enabled: overrides.get(builtIn.name)?.enabled ?? true,
        scope: "system",
        ...(builtIn.description ? { description: builtIn.description } : {}),
      });
    }
    for (const [name, override] of overrides) {
      if (!override.enabled) add({ name, enabled: false, scope: "system" });
    }
    listed.set(
      folder.cwd,
      [...skills.values()].sort((left, right) => left.name.localeCompare(right.name)),
    );
  }
  return listed;
});

// Strict JSON on purpose: a settings file with comments is one the user edits
// by hand, and rewriting it would drop them, so it is left to the user.
const ClaudeUserSettingsJson = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));
const decodeClaudeUserSettings = Schema.decodeUnknownEffect(ClaudeUserSettingsJson);

export class ClaudeSkillToggleError extends Schema.TaggedError<ClaudeSkillToggleError>()(
  "ClaudeSkillToggleError",
  {
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

/**
 * Switch a skill on or off for every project through `skillOverrides` in the
 * user `settings.json`. Turning it on removes the entry rather than writing
 * `"on"`, so the user file goes back to how it was; a project, local, or
 * managed settings file can still switch it off, which the next scan shows.
 */
export const setClaudeSkillEnabled = Effect.fn("setClaudeSkillEnabled")(function* (input: {
  readonly config: Pick<ClaudeSettings, "homePath">;
  readonly environment: NodeJS.ProcessEnv;
  readonly name: string;
  readonly enabled: boolean;
}): Effect.fn.Return<void, ClaudeSkillToggleError, FileSystem.FileSystem | Path.Path> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const settingsPath = path.join(
    yield* resolveClaudeConfigDirPath(input.config, input.environment),
    "settings.json",
  );
  const contents = yield* fileSystem.readFileString(settingsPath).pipe(
    Effect.catchTag("PlatformError", (error) =>
      error.reason._tag === "NotFound"
        ? Effect.succeed("{}")
        : Effect.fail(
            new ClaudeSkillToggleError({
              detail: `Could not read ${settingsPath}.`,
              cause: error,
            }),
          ),
    ),
  );
  const settings = yield* decodeClaudeUserSettings(contents.trim() === "" ? "{}" : contents).pipe(
    Effect.mapError(
      (cause) =>
        new ClaudeSkillToggleError({
          detail: `${settingsPath} is not plain JSON (it may have comments). Edit skillOverrides there by hand.`,
          cause,
        }),
    ),
  );
  const current = settings.skillOverrides;
  const overrides: Record<string, unknown> =
    current !== null && typeof current === "object" && !Array.isArray(current)
      ? { ...current }
      : {};
  if (input.enabled) {
    delete overrides[input.name];
  } else {
    overrides[input.name] = "off";
  }
  const { skillOverrides: _previous, ...rest } = settings;
  const next = Object.keys(overrides).length === 0 ? rest : { ...rest, skillOverrides: overrides };
  yield* writeFileStringAtomically({
    filePath: settingsPath,
    // Pretty-printed like the CLI writes it; a Schema encode would be one line.
    // @effect-diagnostics-next-line preferSchemaOverJson:off
    contents: `${JSON.stringify(next, null, 2)}\n`,
  }).pipe(
    Effect.mapError(
      (cause) => new ClaudeSkillToggleError({ detail: `Could not write ${settingsPath}.`, cause }),
    ),
  );
});
