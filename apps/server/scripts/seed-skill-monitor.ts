#!/usr/bin/env node

/**
 * Seed the Skill Monitor with demo skills and a believable run history, for
 * testing and demos.
 *
 * `vp run seed-skill-monitor` from a worktree, with or without the dev server
 * running:
 *   1. Rewrites a demo project at `<.t3>/demo/skill-monitor`, a git repository
 *      with Claude Code (`.claude/skills`) and Codex (`.agents/skills`)
 *      skills: shared ones, one-harness ones, one Claude Code switches off in
 *      the project, and one that never ran. Each edit of a skill is a commit.
 *   2. Replaces the seeded rows in the Skill Monitor's usage tables with runs
 *      over the last `--days`: models, tokens, time, tools, subagents,
 *      usage-limit shares, the skill version each ran, and some interrupted or
 *      failed turns.
 *   3. Adds the demo project through `t3 project add` unless it is there.
 *
 * Seeded rows carry `seed:` ids, so a rerun replaces them and `--clear`
 * removes them without touching real usage. The same `--seed` gives the same
 * history, relative to now.
 */

import * as NodeCrypto from "node:crypto";
import * as NodeOS from "node:os";

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveWorktreeT3Home } from "@t3tools/shared/devHome";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Console from "effect/Console";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { Command, Flag } from "effect/unstable/cli";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { runMigrations } from "../src/persistence/Migrations.ts";

export class SeedSkillMonitorNotInWorktreeError extends Schema.TaggedError<SeedSkillMonitorNotInWorktreeError>()(
  "SeedSkillMonitorNotInWorktreeError",
  {},
) {
  override get message(): string {
    return "Not inside a linked git worktree. Pass --base-dir to target an isolated .t3 directory.";
  }
}

export class SeedSkillMonitorSharedHomeError extends Schema.TaggedError<SeedSkillMonitorSharedHomeError>()(
  "SeedSkillMonitorSharedHomeError",
  {},
) {
  override get message(): string {
    return "Refusing to seed the shared ~/.t3 data. Use an isolated --base-dir.";
  }
}

type Driver = "claudeAgent" | "codex";
type ToolKind = "command" | "edit" | "search" | "web" | "tool" | "subagent";
type Range = readonly [low: number, high: number];

interface DemoTool {
  readonly kind: ToolKind;
  readonly label: string;
  readonly calls: Range;
  readonly secondsPerCall: Range;
}

interface DemoSkill {
  readonly name: string;
  readonly description: string;
  readonly harnesses: ReadonlyArray<Driver>;
  /** Average runs a week; zero leaves the skill unused. */
  readonly runsPerWeek: number;
  /** A typical run's own tokens, before subagents. */
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly subagentChance: number;
  /** Share of runs the agent loaded the skill itself. */
  readonly agentShare: number;
  readonly waitChance: number;
  /**
   * Each edit of SKILL.md, oldest first. Each is a commit in the demo project,
   * except a final uncommitted one, left in the working tree.
   */
  readonly edits: ReadonlyArray<{
    readonly daysAgo: number;
    readonly note: string;
    readonly uncommitted?: true;
  }>;
  readonly tools: ReadonlyArray<DemoTool>;
  readonly offInClaude?: true;
  /** Runs stop this many days ago, for a skill that fell out of use. */
  readonly lastRunDaysAgo?: number;
}

const command = (label: string, calls: Range, secondsPerCall: Range): DemoTool => ({
  kind: "command",
  label,
  calls,
  secondsPerCall,
});
const EDITS = (calls: Range): DemoTool => ({
  kind: "edit",
  label: "File edits",
  calls,
  secondsPerCall: [0.4, 3],
});
const SEARCH = (calls: Range): DemoTool => ({
  kind: "search",
  label: "File search",
  calls,
  secondsPerCall: [0.2, 2],
});
const WEB = (calls: Range): DemoTool => ({
  kind: "web",
  label: "Web search",
  calls,
  secondsPerCall: [3, 12],
});
const READ = (calls: Range): DemoTool => ({
  kind: "tool",
  label: "Read",
  calls,
  secondsPerCall: [0.1, 0.6],
});

const DEMO_SKILLS: ReadonlyArray<DemoSkill> = [
  {
    name: "code-review",
    description:
      "Review the current diff for bugs, risky changes, and missing tests before a pull request is opened. Use when the user asks for a review or says a change is ready.",
    harnesses: ["claudeAgent", "codex"],
    runsPerWeek: 30,
    inputTokens: 220_000,
    outputTokens: 7_000,
    subagentChance: 0.35,
    agentShare: 0.2,
    waitChance: 0.15,
    edits: [
      { daysAgo: 38, note: "Flag changed behavior that has no test." },
      { daysAgo: 9, note: "Check new migrations and feature flags." },
    ],
    tools: [
      command("pnpm test", [1, 3], [20, 95]),
      command("git diff", [1, 4], [0.2, 1]),
      SEARCH([3, 12]),
      READ([6, 20]),
    ],
  },
  {
    name: "write-tests",
    description:
      "Write focused tests for new or changed behavior, following the testing conventions already in the repository.",
    harnesses: ["claudeAgent", "codex"],
    runsPerWeek: 22,
    inputTokens: 160_000,
    outputTokens: 14_000,
    subagentChance: 0.15,
    agentShare: 0.35,
    waitChance: 0.1,
    edits: [
      { daysAgo: 21, note: "Write one focused test per behavior." },
      { daysAgo: 4, note: "Cover the error paths too.", uncommitted: true },
    ],
    tools: [EDITS([2, 8]), command("pnpm vitest run", [2, 6], [8, 60]), SEARCH([2, 8])],
  },
  {
    name: "deploy-preview",
    description: "Build the app and publish a preview deployment for the current branch.",
    harnesses: ["claudeAgent", "codex"],
    runsPerWeek: 10,
    inputTokens: 70_000,
    outputTokens: 2_500,
    subagentChance: 0,
    agentShare: 0.05,
    waitChance: 0.6,
    edits: [],
    tools: [
      command("pnpm build", [1, 2], [45, 140]),
      command("vercel deploy", [1, 1], [30, 110]),
      command("gh pr comment", [1, 1], [1, 3]),
    ],
  },
  {
    name: "changelog",
    description: "Draft release notes from the commits since the last tag.",
    harnesses: ["claudeAgent"],
    runsPerWeek: 7,
    inputTokens: 45_000,
    outputTokens: 3_000,
    subagentChance: 0,
    agentShare: 0.1,
    waitChance: 0.05,
    edits: [],
    tools: [command("git log", [1, 3], [0.3, 1.5]), EDITS([1, 2])],
  },
  {
    name: "db-migration",
    description:
      "Plan and write a database migration, generate the client, and check it applies cleanly to a scratch database.",
    harnesses: ["codex"],
    runsPerWeek: 7,
    inputTokens: 130_000,
    outputTokens: 9_000,
    subagentChance: 0.1,
    agentShare: 0.15,
    waitChance: 0.4,
    edits: [{ daysAgo: 16, note: "Regenerate the client after each migration." }],
    tools: [
      command("pnpm db:migrate", [1, 3], [4, 25]),
      command("pnpm db:generate", [1, 2], [3, 12]),
      EDITS([2, 6]),
    ],
  },
  {
    name: "pr-description",
    description: "Write a pull request title and description from the branch's commits and diff.",
    harnesses: ["claudeAgent", "codex"],
    runsPerWeek: 26,
    inputTokens: 38_000,
    outputTokens: 1_800,
    subagentChance: 0,
    agentShare: 0.5,
    waitChance: 0,
    edits: [],
    tools: [command("gh pr view", [1, 2], [1, 4]), command("git diff", [1, 2], [0.2, 1])],
  },
  {
    name: "perf-audit",
    description:
      "Profile a slow page or endpoint, compare it against the last benchmark run, and propose the fixes with the biggest payoff. Use for performance regressions.",
    harnesses: ["claudeAgent"],
    runsPerWeek: 5,
    inputTokens: 420_000,
    outputTokens: 18_000,
    subagentChance: 0.8,
    agentShare: 0.1,
    waitChance: 0.2,
    edits: [{ daysAgo: 27, note: "Compare against the last saved benchmark." }],
    tools: [WEB([2, 6]), command("pnpm bench", [1, 3], [30, 180]), READ([10, 30])],
  },
  {
    name: "triage-issue",
    description: "Reproduce a reported issue, find the likely cause, and label it.",
    harnesses: ["claudeAgent", "codex"],
    runsPerWeek: 15,
    inputTokens: 90_000,
    outputTokens: 4_000,
    subagentChance: 0.1,
    agentShare: 0.25,
    waitChance: 0.1,
    edits: [],
    tools: [command("gh issue view", [1, 3], [1, 3]), WEB([1, 3]), SEARCH([2, 10])],
  },
  {
    name: "refactor-module",
    description:
      "Restructure a module without changing its behavior, keeping the public API and tests passing.",
    harnesses: ["claudeAgent", "codex"],
    runsPerWeek: 16,
    inputTokens: 310_000,
    outputTokens: 26_000,
    subagentChance: 0.25,
    agentShare: 0.1,
    waitChance: 0.2,
    edits: [
      { daysAgo: 44, note: "Keep the public API unchanged." },
      { daysAgo: 12, note: "Run the typecheck after each step." },
    ],
    tools: [EDITS([8, 30]), command("pnpm typecheck", [1, 4], [20, 70]), SEARCH([4, 15])],
  },
  {
    name: "legacy-release",
    description: "Cut a release with the old shell script. Replaced by deploy-preview.",
    harnesses: ["claudeAgent"],
    runsPerWeek: 3,
    inputTokens: 60_000,
    outputTokens: 2_000,
    subagentChance: 0,
    agentShare: 0,
    waitChance: 0.5,
    edits: [],
    tools: [command("./scripts/release.sh", [1, 1], [60, 240])],
    offInClaude: true,
    lastRunDaysAgo: 40,
  },
  {
    name: "brand-voice",
    description:
      "Rewrite user-facing copy in the product's voice: plain, direct, and free of jargon.",
    harnesses: ["claudeAgent", "codex"],
    runsPerWeek: 0,
    inputTokens: 0,
    outputTokens: 0,
    subagentChance: 0,
    agentShare: 0,
    waitChance: 0,
    edits: [],
    tools: [],
  },
];

interface DemoModel {
  readonly model: string;
  /** USD per million uncached input, cached input, and output tokens. */
  readonly price: { readonly input: number; readonly cached: number; readonly output: number };
}
/** The model each harness's runs use. */
const MODELS: Record<Driver, DemoModel> = {
  claudeAgent: { model: "claude-opus-5-5", price: { input: 5, cached: 0.5, output: 25 } },
  codex: { model: "gpt-6-astra", price: { input: 1.25, cached: 0.125, output: 10 } },
};
/** Percent of each usage limit a dollar of usage takes. */
const LIMIT_RATES: Record<Driver, { session: number; weekly: number }> = {
  claudeAgent: { session: 8, weekly: 1.1 },
  codex: { session: 25, weekly: 3.4 },
};
const CACHED_SHARE: Record<Driver, number> = { claudeAgent: 0.88, codex: 0.8 };
/**
 * What a run of each version costs next to the skill's first, so its charts
 * tell a story: an edit that bloated the skill, then one that trimmed it below
 * where it started. Each harness reacts a little differently.
 */
const VERSION_COST: Record<Driver, { readonly middle: number; readonly last: number }> = {
  claudeAgent: { middle: 1.7, last: 0.6 },
  codex: { middle: 1.45, last: 0.7 },
};
const versionCost = (skill: DemoSkill, version: number, driver: Driver) =>
  version === 0
    ? 1
    : version === skill.edits.length
      ? VERSION_COST[driver].last
      : VERSION_COST[driver].middle;
const SUBAGENT_TITLES = ["Explore", "Review changes", "Check tests", "Research"];

const DAY_MS = 24 * 60 * 60 * 1000;
const SEED_PREFIX = "seed:";

/** Deterministic, so a seed reproduces the same history. */
const makeRandom = (seed: number) => {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  const between = ([low, high]: Range) => low + (high - low) * next();
  return {
    next,
    between,
    int: (range: Range) => Math.round(between(range)),
    chance: (probability: number) => next() < probability,
    /** Mostly near 1, now and then far off it, like real run sizes. */
    spread: () => Math.exp((next() + next() + next() - 1.5) * 0.6),
  };
};
type Random = ReturnType<typeof makeRandom>;

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/**
 * SKILL.md after its first `version` edits. A JSON string is a valid YAML
 * scalar, so descriptions may hold colons.
 */
const skillFile = (skill: DemoSkill, version = skill.edits.length) =>
  [
    `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`,
    `# ${skill.name}\n`,
    `${skill.description}\n`,
    ...skill.edits.slice(0, version).map((edit) => `- ${edit.note}`),
    "\nDemo skill written by `vp run seed-skill-monitor`.\n",
  ].join("\n");

interface Rows {
  readonly invocations: Array<Record<string, string | null>>;
  readonly usage: Array<Record<string, string | number | null>>;
  readonly timing: Array<Record<string, string | number>>;
  readonly tools: Array<Record<string, string | number>>;
}

const toolGroups = (random: Random, tools: ReadonlyArray<DemoTool>, scale: number) =>
  tools.flatMap((tool) => {
    const calls = Math.max(0, Math.round(random.int(tool.calls) * Math.min(1, scale + 0.2)));
    if (calls === 0) return [];
    const durations = Array.from(
      { length: calls },
      () => random.between(tool.secondsPerCall) * 1000,
    );
    return [
      {
        kind: tool.kind,
        label: tool.label,
        calls,
        total_ms: Math.round(durations.reduce((total, ms) => total + ms, 0)),
        max_ms: Math.round(Math.max(...durations)),
      },
    ];
  });

/** One run's agent: its tokens and its share of each usage limit. */
const usagePart = (
  random: Random,
  driver: Driver,
  model: DemoModel,
  inputTokens: number,
  outputTokens: number,
) => {
  const input = Math.round(inputTokens);
  const cached = Math.round(
    input * Math.min(0.97, CACHED_SHARE[driver] + random.between([-0.06, 0.06])),
  );
  const output = Math.round(outputTokens);
  const price = model.price;
  const costUsd =
    ((input - cached) * price.input + cached * price.cached + output * price.output) / 1_000_000;
  // Peak hours burn the limits faster.
  const pace = random.between([0.85, 1.25]);
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    session_percent: costUsd * LIMIT_RATES[driver].session * pace,
    weekly_percent: costUsd * LIMIT_RATES[driver].weekly * pace,
  };
};

/** Every seeded row, newest runs included, for `days` before `nowMs`. */
export function seedRows(input: {
  readonly seed: number;
  readonly days: number;
  readonly nowMs: number;
  readonly demoDir: string;
}): Rows {
  const random = makeRandom(input.seed);
  const rows: Rows = { invocations: [], usage: [], timing: [], tools: [] };
  let turn = 0;
  for (const skill of DEMO_SKILLS) {
    const runs = Math.round(skill.runsPerWeek * (input.days / 7) * random.between([0.8, 1.2]));
    for (let run = 0; run < runs; run++) {
      const earliest = skill.lastRunDaysAgo ?? 0;
      // Denser toward today, mostly in working hours.
      const daysAgo = earliest + (input.days - earliest) * random.next() ** 1.8;
      const dayStartMs = input.nowMs - Math.floor(daysAgo) * DAY_MS;
      const recordedMs = Math.min(
        input.nowMs - random.between([60_000, 3_600_000]),
        dayStartMs - (dayStartMs % DAY_MS) + random.between([8, 20]) * 3_600_000,
      );
      const recordedAt = DateTime.formatIso(DateTime.makeUnsafe(recordedMs));
      const driver =
        skill.harnesses.length === 1
          ? skill.harnesses[0]!
          : random.chance(0.65)
            ? "claudeAgent"
            : "codex";
      const model = MODELS[driver];
      const status = random.chance(0.9)
        ? "completed"
        : random.chance(0.6)
          ? "interrupted"
          : "failed";
      // Runs before an edit ran the version it replaced.
      const version = skill.edits.filter((edit) => edit.daysAgo >= daysAgo).length;
      const cost = versionCost(skill, version, driver);
      const scale =
        (status === "completed" ? 1 : random.between([0.2, 0.7])) * random.spread() * cost;
      const rootTurnId = `${SEED_PREFIX}turn:${String(turn++).padStart(5, "0")}`;
      rows.invocations.push({
        root_turn_id: rootTurnId,
        skill_name: skill.name,
        thread_id: `${SEED_PREFIX}thread:${turn % 23}`,
        driver,
        model: model.model,
        skill_path: `${input.demoDir}/${driver === "claudeAgent" ? ".claude" : ".agents"}/skills/${skill.name}/SKILL.md`,
        content_hash: sha256(skillFile(skill, version)),
        source: random.chance(skill.agentShare) ? "agent" : "user",
        turn_status: status,
        recorded_at: recordedAt,
      });

      const rootTools = toolGroups(random, skill.tools, scale);
      rows.usage.push({
        root_turn_id: rootTurnId,
        part_id: rootTurnId,
        recorded_at: recordedAt,
        ...usagePart(
          random,
          driver,
          model,
          skill.inputTokens * scale,
          skill.outputTokens * scale * random.spread(),
        ),
      });
      if (status === "completed" && random.chance(skill.subagentChance)) {
        const subagents = random.int([1, 3]);
        const firstTitle = Math.floor(random.next() * SUBAGENT_TITLES.length);
        for (let index = 0; index < subagents; index++) {
          const partId = `${SEED_PREFIX}agent:${turn}:${index}`;
          const subagentTools = toolGroups(random, [SEARCH([3, 12]), READ([5, 25])], 1);
          rows.usage.push({
            root_turn_id: rootTurnId,
            part_id: partId,
            recorded_at: recordedAt,
            ...usagePart(
              random,
              driver,
              model,
              skill.inputTokens * cost * random.between([0.2, 0.45]),
              skill.outputTokens * cost * random.between([0.15, 0.4]),
            ),
          });
          for (const group of subagentTools) {
            rows.tools.push({ root_turn_id: rootTurnId, part_id: partId, ...group });
          }
          const ownMs = subagentTools.reduce((total, group) => total + group.total_ms, 0);
          rootTools.push({
            kind: "subagent",
            // Distinct per run: a run's tool rows are keyed by label.
            label: SUBAGENT_TITLES[(firstTitle + index) % SUBAGENT_TITLES.length]!,
            calls: 1,
            total_ms: Math.round(ownMs + random.between([20, 90]) * 1000),
            max_ms: Math.round(ownMs + random.between([20, 90]) * 1000),
          });
        }
      }
      for (const group of rootTools) {
        rows.tools.push({ root_turn_id: rootTurnId, part_id: rootTurnId, ...group });
      }

      const calls = rootTools.reduce((total, group) => total + group.calls, 0);
      // Calls overlap, so the turn spends a little less than their sum.
      const toolMs = Math.round(
        rootTools.reduce((total, group) => total + group.total_ms, 0) * random.between([0.75, 1]),
      );
      const modelMs = Math.round(
        skill.outputTokens * scale * random.between([12, 22]) + calls * random.between([800, 1600]),
      );
      const waitingMs = random.chance(skill.waitChance)
        ? Math.round(random.between([5, 120]) * 1000)
        : 0;
      rows.timing.push({
        root_turn_id: rootTurnId,
        total_ms: modelMs + toolMs + waitingMs,
        model_ms: modelMs,
        tool_ms: toolMs,
        waiting_ms: waitingMs,
        recorded_at: recordedAt,
      });
    }
  }
  return rows;
}

const SEEDED_TABLES = [
  "skill_invocations",
  "skill_turn_usage",
  "skill_turn_timing",
  "skill_turn_tools",
] as const;

/** Replaces the seeded rows, or only removes them when `rows` is undefined. */
const writeRows = (rows: Rows | undefined) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const table of SEEDED_TABLES) {
          yield* sql`DELETE FROM ${sql(table)} WHERE root_turn_id LIKE ${`${SEED_PREFIX}%`}`;
        }
        if (rows === undefined) return;
        const tables = [
          ["skill_invocations", rows.invocations],
          ["skill_turn_usage", rows.usage],
          ["skill_turn_timing", rows.timing],
          ["skill_turn_tools", rows.tools],
        ] as const;
        for (const [table, tableRows] of tables) {
          // SQLite caps a statement's bound values; a few hundred rows stay well under it.
          for (let start = 0; start < tableRows.length; start += 200) {
            yield* sql`INSERT INTO ${sql(table)} ${sql.insert(tableRows.slice(start, start + 200))}`;
          }
        }
      }),
    );
  });

/** Runs a command to completion, reporting whether it succeeded. */
const runQuietly = (
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(command, args, {
          ...options,
          extendEnv: true,
          stdout: "ignore",
          stderr: "inherit",
        }),
      );
      return (yield* child.exitCode) === 0;
    }),
  );

/**
 * Rebuilds the demo project as its own git repository, so neither harness
 * looks for skills in the checkout around it: one commit adds the skills
 * before the history starts, then one commit per edit, on the day it landed.
 */
const writeDemoProject = Effect.fn("writeDemoProject")(function* (input: {
  readonly demoDir: string;
  readonly nowMs: number;
  readonly days: number;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { demoDir } = input;
  yield* fs.remove(demoDir, { recursive: true }).pipe(Effect.orElseSucceed(() => undefined));
  yield* fs.makeDirectory(path.join(demoDir, ".claude"), { recursive: true });

  const git = (args: ReadonlyArray<string>, env?: Record<string, string>) =>
    runQuietly(
      "git",
      [
        "-c",
        "user.name=Skill Monitor demo",
        "-c",
        "user.email=demo@example.com",
        "-c",
        "commit.gpgsign=false",
        "-c",
        "core.hooksPath=.git/hooks",
        ...args,
      ],
      { cwd: demoDir, ...(env === undefined ? {} : { env }) },
    );
  const commit = (message: string, daysAgo: number) => {
    const date = `@${Math.floor((input.nowMs - daysAgo * DAY_MS) / 1000)} +0000`;
    return git(["add", "--all"]).pipe(
      Effect.andThen(
        git(["commit", "--quiet", "--message", message], {
          GIT_AUTHOR_DATE: date,
          GIT_COMMITTER_DATE: date,
        }),
      ),
    );
  };
  const writeSkill = (skill: DemoSkill, version: number) =>
    Effect.forEach(
      skill.harnesses,
      (driver) => {
        const directory = path.join(
          demoDir,
          driver === "claudeAgent" ? ".claude" : ".agents",
          "skills",
          skill.name,
        );
        return fs
          .makeDirectory(directory, { recursive: true })
          .pipe(
            Effect.andThen(
              fs.writeFileString(path.join(directory, "SKILL.md"), skillFile(skill, version)),
            ),
          );
      },
      { discard: true },
    );

  yield* git(["init", "--quiet"]);
  yield* fs.writeFileString(
    path.join(demoDir, "README.md"),
    "# Skill Monitor demo\n\nWritten by `vp run seed-skill-monitor`, which rewrites it each run.\n",
  );
  const skillOverrides = Object.fromEntries(
    DEMO_SKILLS.filter((skill) => skill.offInClaude).map((skill) => [skill.name, "off"]),
  );
  yield* fs.writeFileString(
    path.join(demoDir, ".claude", "settings.json"),
    `${encodeJson({ skillOverrides })}\n`,
  );
  yield* Effect.forEach(DEMO_SKILLS, (skill) => writeSkill(skill, 0), { discard: true });
  const edits = DEMO_SKILLS.flatMap((skill) =>
    skill.edits.map((edit, index) => ({ skill, edit, version: index + 1 })),
  ).toSorted((left, right) => right.edit.daysAgo - left.edit.daysAgo);
  const oldestEdit = edits[0]?.edit.daysAgo ?? 0;
  yield* commit("Add demo skills", Math.max(input.days, oldestEdit) + 1);
  for (const { skill, edit, version } of edits) {
    if (edit.uncommitted) continue;
    yield* writeSkill(skill, version);
    const summary = edit.note.replace(/\.$/u, "");
    yield* commit(`${skill.name}: ${summary[0]!.toLowerCase()}${summary.slice(1)}`, edit.daysAgo);
  }
  // After every commit, so none of them picks these up.
  for (const { skill, edit, version } of edits) {
    if (edit.uncommitted) yield* writeSkill(skill, version);
  }
});

/** Adds the demo project through the CLI, live or offline, unless it exists. */
const addDemoProject = Effect.fn("addDemoProject")(function* (baseDir: string, demoDir: string) {
  const sql = yield* SqlClient.SqlClient;
  const existing = yield* sql<{ readonly projectId: string }>`
    SELECT project_id AS "projectId" FROM projection_projects
    WHERE workspace_root = ${demoDir} AND deleted_at IS NULL
  `;
  if (existing.length > 0) return "already added";
  const path = yield* Path.Path;
  const binPath = yield* path.fromFileUrl(new URL("../src/bin.ts", import.meta.url));
  const added = yield* runQuietly(process.execPath, [
    binPath,
    "project",
    "add",
    demoDir,
    "--base-dir",
    baseDir,
    "--title",
    "Skill Monitor demo",
  ]);
  return added ? "added" : "could not be added; add it in the app";
});

export interface SeedSkillMonitorInput {
  /** Isolated .t3 directory. Defaults to `<worktree>/.t3` of the cwd. */
  readonly baseDir?: string | undefined;
  readonly days: number;
  readonly seed: number;
  /** Remove the seeded rows instead of writing new ones. */
  readonly clear: boolean;
  /** Skip `t3 project add`, for tests. */
  readonly addProject: boolean;
}

export interface SeedSkillMonitorOptions {
  /** Overridable for tests; the directory writes must never target. */
  readonly sharedHome?: string | undefined;
}

export const runSeedSkillMonitor = Effect.fn("runSeedSkillMonitor")(function* (
  input: SeedSkillMonitorInput,
  options: SeedSkillMonitorOptions = {},
) {
  if (input.days < 1) return yield* Effect.die("days must be >= 1");
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const baseDir =
    input.baseDir !== undefined
      ? path.resolve(input.baseDir)
      : yield* resolveWorktreeT3Home(process.cwd());
  if (baseDir === undefined) return yield* new SeedSkillMonitorNotInWorktreeError();
  const sharedHome = path.resolve(options.sharedHome ?? path.join(NodeOS.homedir(), ".t3"));
  const [baseDirTarget, canonicalSharedHome] = yield* Effect.all([
    fs.realPath(baseDir).pipe(Effect.orElseSucceed(() => baseDir)),
    fs.realPath(sharedHome).pipe(Effect.orElseSucceed(() => sharedHome)),
  ]);
  if (baseDirTarget === canonicalSharedHome) return yield* new SeedSkillMonitorSharedHomeError();
  yield* fs.makeDirectory(path.join(baseDir, "userdata"), { recursive: true });
  // Canonical, so the demo project's path matches what the project CLI records.
  const canonicalBaseDir = yield* fs.realPath(baseDir);

  const databasePath = path.join(canonicalBaseDir, "userdata", "statev2.sqlite");
  const demoDir = path.join(canonicalBaseDir, "demo", "skill-monitor");
  return yield* Effect.gen(function* () {
    yield* runMigrations();
    if (input.clear) {
      yield* writeRows(undefined);
      return { databasePath, demoDir, runs: 0, project: "left as is" };
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    yield* writeDemoProject({ demoDir, nowMs, days: input.days });
    const rows = seedRows({ seed: input.seed, days: input.days, nowMs, demoDir });
    yield* writeRows(rows);
    const project = input.addProject ? yield* addDemoProject(canonicalBaseDir, demoDir) : "skipped";
    return { databasePath, demoDir, runs: rows.timing.length, project };
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));
});

export const seedSkillMonitorCommand = Command.make(
  "seed-skill-monitor",
  {
    baseDir: Flag.String("base-dir").pipe(
      Flag.optional,
      Flag.withDescription("Isolated .t3 directory. Defaults to the current worktree's .t3."),
    ),
    days: Flag.Int("days").pipe(
      Flag.withDefault(60),
      Flag.withDescription("How many days of history to write."),
    ),
    seed: Flag.Int("seed").pipe(
      Flag.withDefault(1),
      Flag.withDescription("Seed for the generated history; the same seed gives the same runs."),
    ),
    clear: Flag.Boolean("clear").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Remove the seeded runs and keep the demo project."),
    ),
  },
  ({ baseDir, days, seed, clear }) =>
    Effect.gen(function* () {
      const result = yield* runSeedSkillMonitor({
        baseDir: Option.getOrUndefined(baseDir),
        days,
        seed,
        clear,
        addProject: true,
      });
      if (clear) {
        yield* Console.log(`Removed the seeded Skill Monitor runs from ${result.databasePath}.`);
        return;
      }
      yield* Console.log(`Seeded ${result.runs} skill runs into ${result.databasePath}.`);
      yield* Console.log(`Demo project ${result.project}: ${result.demoDir}`);
      yield* Console.log(
        "Open a thread in the Skill Monitor demo project, then open Skill Monitor from the right panel or command palette.",
      );
      yield* Console.log(
        "Fullest charts: code-review (3 committed versions, Opus 5.5 and Astra) and write-tests (an uncommitted version).",
      );
    }),
).pipe(
  Command.withDescription(
    "Seed the Skill Monitor with demo skills and a believable run history in an isolated dev home.",
  ),
);

if (import.meta.main) {
  Command.run(seedSkillMonitorCommand, { version: "0.0.0" }).pipe(
    Effect.provide(NodeServices.layer),
    NodeRuntime.runMain,
  );
}
