/**
 * SkillUsage - records the skills each user turn ran and the tokens it used,
 * its subagents included, and answers per-skill averages for the Skill Monitor.
 *
 * A user turn is a provider turn with a run attempt. Subagent work rolls up to
 * the user turn that launched it: Codex reports usage on each subagent provider
 * turn, Claude on the subagent's terminal `subagent.updated`. Each agent's
 * usage is its own row, replaced on repeat, so late subagents still count and
 * nothing counts twice. Each row also keeps its estimated share of the
 * account's usage limits; see `skillQuota.ts`.
 *
 * @module usage/SkillUsage
 */
import * as NodeCrypto from "node:crypto";

import {
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderTurnId,
  type ServerProvider,
  type ServerProviderUsageWindow,
  MAX_SKILL_SLOWEST_TOOLS,
  MAX_SKILL_TOOL_CATALOG_ENTRIES,
  SKILL_RECENT_SESSION_DAYS,
  type SkillToolCatalog,
  type SkillToolCatalogInput,
  SkillToolKind,
  type SkillToolRef,
  type SkillUsageDetail,
  type SkillUsageDetailInput,
  SkillUsageReadError,
  type SkillUsageSummary,
  type SkillUsageSummaryInput,
  type SkillVersionCommit,
  type ThreadId,
} from "@t3tools/contracts";
import { SKILL_MENTION_PATTERN } from "@t3tools/shared/composerInlineTokens";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { claudeSkillInvocation } from "@t3tools/shared/toolActivity";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { VcsProcess } from "../vcs/VcsProcess.ts";
import {
  type QuotaRate,
  quotaPercentOf,
  quotaRateOf,
  quotaWindowsOf,
  spendQueryOf,
} from "./skillQuota.ts";
import { type ToolGroup, type TurnTiming, toolGroupsOf, turnTimingOf } from "./skillTiming.ts";
import { versionCommitsAt } from "./skillVersionCommits.ts";
import { UsageService } from "./UsageService.ts";

export class SkillUsage extends Context.Service<
  SkillUsage,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly readSummary: (
      input: SkillUsageSummaryInput,
    ) => Effect.Effect<SkillUsageSummary, SkillUsageReadError>;
    /** One skill's runs by version and model, versions named after their commits. */
    readonly readDetail: (
      input: SkillUsageDetailInput,
    ) => Effect.Effect<SkillUsageDetail, SkillUsageReadError>;
    /** The tools skill runs called, to pick columns from. */
    readonly readToolCatalog: (
      input: SkillToolCatalogInput,
    ) => Effect.Effect<SkillToolCatalog, SkillUsageReadError>;
  }
>()("t3/usage/SkillUsage") {}

type SkillSource = "user" | "agent";

const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "interrupted",
  "cancelled",
]);
// Subagents nest a few levels at most; the bound only stops a malformed chain.
const MAX_ROLLUP_DEPTH = 16;
// Each estimate scans transcripts, so one per instance serves the turns that
// finish within this long of it.
const QUOTA_RATE_TTL_MS = 5 * 60_000;
const LEADING_SLASH_COMMAND = /^\/([a-zA-Z0-9][a-zA-Z0-9:_-]*)(?=\s|$)/u;

/**
 * Skills named in a user turn: `$name` mentions anywhere and a leading
 * `/name`, kept only when the provider lists a skill by that name, plus the
 * skills the agent loaded itself. A skill the user named counts as theirs.
 */
export function skillsUsedInTurn(input: {
  readonly messageText: string;
  readonly agentSkillNames: ReadonlyArray<string>;
  readonly catalogNames: ReadonlySet<string>;
}): ReadonlyMap<string, SkillSource> {
  const used = new Map<string, SkillSource>();
  const named = [
    ...Array.from(input.messageText.matchAll(SKILL_MENTION_PATTERN), (match) => match[2] ?? ""),
    LEADING_SLASH_COMMAND.exec(input.messageText)?.[1] ?? "",
  ];
  for (const name of named) {
    if (input.catalogNames.has(name)) used.set(name, "user");
  }
  for (const name of input.agentSkillNames) {
    if (!used.has(name)) used.set(name, "agent");
  }
  return used;
}

function skillsForCwd(provider: ServerProvider, cwd: string | null) {
  return (
    (cwd === null
      ? undefined
      : provider.workspaceSnapshots?.find((snapshot) => snapshot.cwd === cwd)?.skills) ??
    provider.skills
  );
}

function sha256(bytes: Uint8Array): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex");
}

const SkillVersionRow = Schema.Struct({
  skillName: Schema.String,
  contentHash: Schema.NullOr(Schema.String),
  runs: Schema.Number,
  avgInputTokens: Schema.Number,
  avgCachedInputTokens: Schema.Number,
  avgOutputTokens: Schema.Number,
  timedRuns: Schema.Number,
  avgTotalMs: Schema.Number,
  avgModelMs: Schema.Number,
  avgToolMs: Schema.Number,
  avgWaitingMs: Schema.Number,
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
});
type SkillVersionRow = typeof SkillVersionRow.Type;

const RecentInvocationsRow = Schema.Struct({
  skillName: Schema.String,
  invocations: Schema.Number,
});
type RecentInvocationsRow = typeof RecentInvocationsRow.Type;

const SkillToolRow = Schema.Struct({
  skillName: Schema.String,
  kind: SkillToolKind,
  label: Schema.String,
  calls: Schema.Number,
  totalMs: Schema.Number,
  maxMs: Schema.Number,
});
type SkillToolRow = typeof SkillToolRow.Type;

const SkillToolCatalogRow = Schema.Struct({
  kind: SkillToolKind,
  label: Schema.String,
  runs: Schema.Number,
  calls: Schema.Number,
});

const SkillNameRow = Schema.Struct({ skillName: Schema.String });

const toolKey = (tool: SkillToolRef) => `${tool.kind}\u0000${tool.label}`;
const toolUsageOf = ({ kind, label, calls, totalMs, maxMs }: SkillToolRow) => ({
  kind,
  label,
  calls,
  totalMs,
  maxMs,
});

const SkillQuotaRow = Schema.Struct({
  skillName: Schema.String,
  driver: ProviderDriverKind,
  sessionRuns: Schema.Number,
  avgSessionPercent: Schema.Number,
  weeklyRuns: Schema.Number,
  avgWeeklyPercent: Schema.Number,
  recentSessionRuns: Schema.Number,
  recentSessionPercent: Schema.Number,
});
type SkillQuotaRow = typeof SkillQuotaRow.Type;

const SkillBreakdownRow = Schema.Struct({
  contentHash: Schema.String,
  driver: Schema.NullOr(ProviderDriverKind),
  model: Schema.NullOr(Schema.String),
  runs: Schema.Number,
  avgInputTokens: Schema.Number,
  avgCachedInputTokens: Schema.Number,
  avgOutputTokens: Schema.Number,
  timedRuns: Schema.Number,
  avgTotalMs: Schema.Number,
  avgModelMs: Schema.Number,
  avgToolMs: Schema.Number,
  avgWaitingMs: Schema.Number,
  sessionRuns: Schema.Number,
  avgSessionPercent: Schema.Number,
  weeklyRuns: Schema.Number,
  avgWeeklyPercent: Schema.Number,
  recentSessionRuns: Schema.Number,
  recentSessionPercent: Schema.Number,
});
type SkillBreakdownRow = typeof SkillBreakdownRow.Type;

const SkillVersionPathRow = Schema.Struct({
  contentHash: Schema.String,
  skillPath: Schema.NullOr(Schema.String),
  firstSeenAt: Schema.String,
  lastSeenAt: Schema.String,
});
type SkillVersionPathRow = typeof SkillVersionPathRow.Type;

interface QuotaRates {
  readonly session: QuotaRate | null;
  readonly weekly: QuotaRate | null;
}
const NO_QUOTA_RATES: QuotaRates = { session: null, weekly: null };

/** The user turn a node's work rolls up to, and the instance that ran it. */
interface UserTurn {
  readonly id: ProviderTurnId;
  readonly instanceId: ProviderInstanceId | null;
}

type AverageKey = keyof Pick<
  SkillVersionRow,
  | "avgInputTokens"
  | "avgCachedInputTokens"
  | "avgOutputTokens"
  | "avgTotalMs"
  | "avgModelMs"
  | "avgToolMs"
  | "avgWaitingMs"
>;

/** Averages across versions, each weighted by the runs that measured it. */
function averagesOf(versions: ReadonlyArray<SkillVersionRow>) {
  const runs = versions.reduce((total, version) => total + version.runs, 0);
  const timedRuns = versions.reduce((total, version) => total + version.timedRuns, 0);
  const weighted = (key: AverageKey, weight: "runs" | "timedRuns") => {
    const count = weight === "runs" ? runs : timedRuns;
    return count === 0
      ? 0
      : versions.reduce((total, version) => total + version[key] * version[weight], 0) / count;
  };
  return {
    runs,
    avgInputTokens: weighted("avgInputTokens", "runs"),
    avgCachedInputTokens: weighted("avgCachedInputTokens", "runs"),
    avgOutputTokens: weighted("avgOutputTokens", "runs"),
    timedRuns,
    avgTotalMs: weighted("avgTotalMs", "timedRuns"),
    avgModelMs: weighted("avgModelMs", "timedRuns"),
    avgToolMs: weighted("avgToolMs", "timedRuns"),
    avgWaitingMs: weighted("avgWaitingMs", "timedRuns"),
  };
}

/**
 * Folds per-version averages into all-time averages per skill, newest version
 * first, with its slowest tools and the `tools` asked for. A skill whose recent
 * turns all stopped early still appears, with no completed runs.
 */
export function summarizeSkillUsage(
  rows: ReadonlyArray<SkillVersionRow>,
  windows: ReadonlyArray<{
    readonly days: number;
    readonly rows: ReadonlyArray<RecentInvocationsRow>;
  }>,
  toolRows: ReadonlyArray<SkillToolRow>,
  quotaRows: ReadonlyArray<SkillQuotaRow>,
  tools: ReadonlyArray<SkillToolRef>,
): SkillUsageSummary {
  const requested = new Set(tools.map(toolKey));
  const byName = new Map<string, Array<SkillVersionRow>>(
    windows.flatMap((window) => window.rows.map((row) => [row.skillName, []] as const)),
  );
  for (const row of rows) {
    byName.set(row.skillName, [...(byName.get(row.skillName) ?? []), row]);
  }
  const counts = windows.map((window) => ({
    days: window.days,
    bySkill: new Map(window.rows.map((row) => [row.skillName, row.invocations])),
  }));
  const toolsByName = new Map<string, Array<SkillToolRow>>();
  for (const row of toolRows) {
    toolsByName.set(row.skillName, [...(toolsByName.get(row.skillName) ?? []), row]);
  }
  const quotaByName = new Map<string, Array<SkillQuotaRow>>();
  for (const row of quotaRows) {
    quotaByName.set(row.skillName, [...(quotaByName.get(row.skillName) ?? []), row]);
  }
  return {
    skills: Array.from(byName, ([skillName, versions]) => ({
      skillName,
      ...averagesOf(versions),
      recentUses: counts.map((window) => ({
        days: window.days,
        invocations: window.bySkill.get(skillName) ?? 0,
      })),
      slowestTools: (toolsByName.get(skillName) ?? [])
        .toSorted((left, right) => right.totalMs - left.totalMs)
        .slice(0, MAX_SKILL_SLOWEST_TOOLS)
        .map(toolUsageOf),
      tools: (toolsByName.get(skillName) ?? [])
        .filter((row) => requested.has(toolKey(row)))
        .map(toolUsageOf),
      versions: versions
        .flatMap((version) =>
          version.contentHash === null
            ? []
            : [
                {
                  contentHash: version.contentHash,
                  firstSeenAt: version.firstSeenAt,
                  lastSeenAt: version.lastSeenAt,
                  ...averagesOf([version]),
                },
              ],
        )
        .toSorted((left, right) => right.lastSeenAt.localeCompare(left.lastSeenAt)),
      quota: (quotaByName.get(skillName) ?? []).map(({ skillName: _name, ...quota }) => quota),
    })),
  };
}

/**
 * The versions with completed runs, oldest first, each named after the oldest
 * commit at any of its paths whose SKILL.md matches. Unnamed versions order by
 * when they were first seen.
 */
export function skillUsageDetailOf(
  skillName: string,
  rows: ReadonlyArray<SkillBreakdownRow>,
  versionRows: ReadonlyArray<SkillVersionPathRow>,
  commitsByPath: ReadonlyMap<string, ReadonlyMap<string, SkillVersionCommit>>,
): SkillUsageDetail {
  const ran = new Set(rows.map((row) => row.contentHash));
  const versions = new Map<
    string,
    { firstSeenAt: string; lastSeenAt: string; commit: SkillVersionCommit | null }
  >();
  for (const row of versionRows) {
    if (!ran.has(row.contentHash)) continue;
    const known = versions.get(row.contentHash);
    const commit =
      row.skillPath === null ? undefined : commitsByPath.get(row.skillPath)?.get(row.contentHash);
    const commits = [known?.commit, commit].filter((candidate) => candidate != null);
    versions.set(row.contentHash, {
      firstSeenAt:
        known === undefined || row.firstSeenAt < known.firstSeenAt
          ? row.firstSeenAt
          : known.firstSeenAt,
      lastSeenAt:
        known === undefined || row.lastSeenAt > known.lastSeenAt
          ? row.lastSeenAt
          : known.lastSeenAt,
      commit:
        commits.toSorted((left, right) => left.committedAt.localeCompare(right.committedAt))[0] ??
        null,
    });
  }
  const sortKey = (version: { firstSeenAt: string; commit: SkillVersionCommit | null }) =>
    version.commit?.committedAt ?? version.firstSeenAt;
  return {
    skillName,
    versions: Array.from(versions, ([contentHash, version]) => ({
      contentHash,
      ...version,
    })).toSorted((left, right) => sortKey(left).localeCompare(sortKey(right))),
    breakdown: rows,
  };
}

type Work =
  | {
      readonly _tag: "turn";
      readonly threadId: ThreadId;
      readonly driver: ProviderDriverKind | undefined;
      readonly turn: OrchestrationV2ProviderTurn;
    }
  | { readonly _tag: "subagent"; readonly subagent: OrchestrationV2Subagent };

export const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const providers = yield* ProviderRegistry;
  const usage = yield* UsageService;
  const fileSystem = yield* FileSystem.FileSystem;
  const vcsProcess = yield* VcsProcess;
  const pathService = yield* Path.Path;
  const sql = yield* SqlClient.SqlClient;

  // Only the worker fiber reads and writes this, one part at a time.
  const quotaRates = new Map<ProviderInstanceId, QuotaRates & { readonly expiresAtMs: number }>();

  /**
   * The instance's current rates, re-estimated at most once per TTL. A window
   * too fresh to estimate from keeps the last rate it had.
   */
  const quotaRatesFor = (instanceId: ProviderInstanceId) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const previous = quotaRates.get(instanceId);
      if (previous !== undefined && previous.expiresAtMs > nowMs) return previous;
      const provider = (yield* providers.getProviders).find(
        (candidate) => candidate.instanceId === instanceId,
      );
      const windows = provider === undefined ? undefined : quotaWindowsOf(provider);
      if (windows === undefined) return NO_QUOTA_RATES;
      const rateOf = (window: ServerProviderUsageWindow | undefined) => {
        const query = window === undefined ? undefined : spendQueryOf(window, now);
        if (window === undefined || query === undefined) return Effect.succeed(null);
        return usage.readSummary(query, { providers: [windows.usage] }).pipe(
          Effect.map((summary) =>
            quotaRateOf(
              window.usedPercent,
              summary.buckets.filter((bucket) => bucket.provider === windows.usage),
            ),
          ),
          Effect.catch((cause) =>
            Effect.logDebug("skill quota rate unavailable", { cause }).pipe(Effect.as(null)),
          ),
        );
      };
      const next = {
        session: (yield* rateOf(windows.session)) ?? previous?.session ?? null,
        weekly: (yield* rateOf(windows.weekly)) ?? previous?.weekly ?? null,
        expiresAtMs: nowMs + QUOTA_RATE_TTL_MS,
      };
      quotaRates.set(instanceId, next);
      return next;
    });

  const writePart = (input: {
    readonly rootTurnId: ProviderTurnId;
    readonly partId: string;
    readonly instanceId: ProviderInstanceId | null;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  }) =>
    Effect.gen(function* () {
      const rates =
        input.instanceId === null ? NO_QUOTA_RATES : yield* quotaRatesFor(input.instanceId);
      const sessionPercent = rates.session === null ? null : quotaPercentOf(rates.session, input);
      const weeklyPercent = rates.weekly === null ? null : quotaPercentOf(rates.weekly, input);
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR REPLACE INTO skill_turn_usage (
          root_turn_id, part_id, input_tokens, cached_input_tokens, output_tokens,
          session_percent, weekly_percent, recorded_at
        ) VALUES (
          ${input.rootTurnId}, ${input.partId}, ${input.inputTokens},
          ${input.cachedInputTokens}, ${input.outputTokens}, ${sessionPercent},
          ${weeklyPercent}, ${recordedAt}
        )
      `;
    });

  const writeTiming = (rootTurnId: ProviderTurnId, timing: TurnTiming) =>
    Effect.gen(function* () {
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR REPLACE INTO skill_turn_timing (
          root_turn_id, total_ms, model_ms, tool_ms, waiting_ms, recorded_at
        ) VALUES (
          ${rootTurnId}, ${timing.wallMs}, ${timing.modelMs}, ${timing.toolMs},
          ${timing.waitingMs}, ${recordedAt}
        )
      `;
    });

  /** Replaces one agent's tool rows for a user turn. */
  const writeTools = (
    rootTurnId: ProviderTurnId,
    partId: string,
    groups: ReadonlyArray<ToolGroup>,
  ) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`
          DELETE FROM skill_turn_tools WHERE root_turn_id = ${rootTurnId} AND part_id = ${partId}
        `;
        yield* Effect.forEach(
          groups,
          (group) => sql`
            INSERT INTO skill_turn_tools (
              root_turn_id, part_id, kind, label, calls, total_ms, max_ms
            ) VALUES (
              ${rootTurnId}, ${partId}, ${group.kind}, ${group.label}, ${group.calls},
              ${group.totalMs}, ${group.maxMs}
            )
          `,
          { discard: true },
        );
      }),
    );

  /** The user turn whose work `nodeId` is part of, or null when there is none. */
  const findUserTurn = (
    threadId: ThreadId,
    nodeId: NodeId,
    depth: number,
  ): Effect.Effect<UserTurn | null, ProjectionStore.ProjectionStoreV2Error> =>
    Effect.gen(function* () {
      if (depth > MAX_ROLLUP_DEPTH) return null;
      const records = yield* projections.getThreadRecords(threadId, [
        "providerTurns",
        "subagents",
        "attempts",
        "runs",
      ]);
      // A run's root node carries its turn; subagent provider turns have no run attempt.
      const turn = records.providerTurns.findLast((candidate) => candidate.nodeId === nodeId);
      if (turn !== undefined && turn.runAttemptId !== null) {
        const attempt = records.attempts.find((candidate) => candidate.id === turn.runAttemptId);
        const run = records.runs.find((candidate) => candidate.id === attempt?.runId);
        return { id: turn.id, instanceId: run?.providerInstanceId ?? null };
      }
      // Claude nests subagents in the parent's thread.
      const subagent = records.subagents.find((candidate) => candidate.id === nodeId);
      if (subagent !== undefined) {
        return yield* findUserTurn(threadId, subagent.parentNodeId, depth + 1);
      }
      // Otherwise the node roots a subagent's own thread: climb to its owner.
      const { lineage } = records.thread;
      if (lineage.relationshipToParent !== "subagent" || lineage.parentThreadId === null) {
        return null;
      }
      const parent = yield* projections.getThreadRecords(lineage.parentThreadId, ["subagents"]);
      const owner = parent.subagents.find((candidate) => candidate.childThreadId === threadId);
      return owner === undefined
        ? null
        : yield* findUserTurn(lineage.parentThreadId, owner.parentNodeId, depth + 1);
    });

  const hashSkillFile = (path: string) =>
    fileSystem.readFile(path).pipe(
      Effect.map(sha256),
      Effect.orElseSucceed(() => null),
    );

  const recordUserTurn = Effect.fnUntraced(function* (
    threadId: ThreadId,
    driver: ProviderDriverKind | undefined,
    turn: OrchestrationV2ProviderTurn,
  ) {
    const records = yield* projections.getThreadRecords(threadId, ["attempts", "runs"]);
    const attempt = records.attempts.find((candidate) => candidate.id === turn.runAttemptId);
    const run = records.runs.find((candidate) => candidate.id === attempt?.runId);
    const tokenUsage = turn.turnTokenUsage;
    if (tokenUsage !== undefined && tokenUsage.usageStatus !== "unavailable") {
      yield* writePart({
        rootTurnId: turn.id,
        partId: turn.id,
        instanceId: run?.providerInstanceId ?? null,
        inputTokens: tokenUsage.inputTokens ?? 0,
        cachedInputTokens: tokenUsage.cachedInputTokens ?? 0,
        outputTokens: tokenUsage.outputTokens ?? 0,
      });
    }
    if (run === undefined) return;
    const message = yield* projections.getRunMessage(threadId, run.id);
    const runItems = yield* projections.getThreadRecords(threadId, ["turnItems"], {
      turnItemRunIds: [run.id],
    });
    const items = runItems.turnItems.filter((item) => item.providerTurnId === turn.id);
    if (turn.startedAt !== null && turn.completedAt !== null) {
      const span = {
        start: DateTime.toEpochMillis(turn.startedAt),
        end: DateTime.toEpochMillis(turn.completedAt),
      };
      yield* writeTiming(turn.id, turnTimingOf(items, span));
      yield* writeTools(turn.id, turn.id, toolGroupsOf(items, span.end, span));
    }
    const agentSkillNames = items.flatMap((item) =>
      item.type === "dynamic_tool"
        ? (claudeSkillInvocation(item.toolName, item.input)?.name ?? [])
        : [],
    );
    const messageText = message?.text ?? "";
    if (agentSkillNames.length === 0 && !/[\p{Sc}/]/u.test(messageText)) return;

    const project = yield* projects.get(records.thread.projectId);
    const cwd =
      records.thread.worktreePath ??
      Option.match(project, { onNone: () => null, onSome: (row) => row.workspaceRoot });
    const provider = (yield* providers.getProviders).find(
      (candidate) => candidate.instanceId === run.providerInstanceId,
    );
    const catalog = provider === undefined ? [] : skillsForCwd(provider, cwd);
    const used = skillsUsedInTurn({
      messageText,
      agentSkillNames,
      catalogNames: new Set(catalog.map((skill) => skill.name)),
    });
    if (used.size === 0) return;

    const recordedAt = DateTime.formatIso(yield* DateTime.now);
    yield* Effect.forEach(
      used,
      ([skillName, source]) =>
        Effect.gen(function* () {
          const path = catalog.find((skill) => skill.name === skillName)?.path ?? null;
          const contentHash = path === null ? null : yield* hashSkillFile(path);
          yield* sql`
            INSERT OR REPLACE INTO skill_invocations (
              root_turn_id, skill_name, thread_id, driver, model, skill_path, content_hash,
              source, turn_status, recorded_at
            ) VALUES (
              ${turn.id}, ${skillName}, ${threadId}, ${driver ?? provider?.driver ?? ""},
              ${run.modelSelection.model}, ${path}, ${contentHash}, ${source}, ${turn.status},
              ${recordedAt}
            )
          `;
        }),
      { discard: true },
    );
  });

  const process = (work: Work) =>
    Effect.gen(function* () {
      if (work._tag === "subagent") {
        const { subagent } = work;
        const tokenUsage = subagent.tokenUsage;
        if (tokenUsage === undefined) return;
        const userTurn = yield* findUserTurn(subagent.threadId, subagent.parentNodeId, 0);
        if (userTurn === null) return;
        const rootTurnId = userTurn.id;
        yield* writePart({
          rootTurnId,
          partId: subagent.id,
          instanceId: userTurn.instanceId,
          ...tokenUsage,
        });
        // Claude runs a subagent's tools in its own child thread.
        if (subagent.childThreadId !== null && subagent.completedAt !== null) {
          const child = yield* projections.getThreadRecords(subagent.childThreadId, ["turnItems"]);
          yield* writeTools(
            rootTurnId,
            subagent.id,
            toolGroupsOf(child.turnItems, DateTime.toEpochMillis(subagent.completedAt)),
          );
        }
        return;
      }
      if (work.turn.runAttemptId !== null) {
        yield* recordUserTurn(work.threadId, work.driver, work.turn);
        return;
      }
      // A subagent's own provider turn (Codex), in the subagent's thread.
      const userTurn = yield* findUserTurn(work.threadId, work.turn.nodeId, 0);
      if (userTurn === null) return;
      const rootTurnId = userTurn.id;
      const tokenUsage = work.turn.turnTokenUsage;
      if (tokenUsage !== undefined && tokenUsage.usageStatus !== "unavailable") {
        yield* writePart({
          rootTurnId,
          partId: work.turn.id,
          instanceId: userTurn.instanceId,
          inputTokens: tokenUsage.inputTokens ?? 0,
          cachedInputTokens: tokenUsage.cachedInputTokens ?? 0,
          outputTokens: tokenUsage.outputTokens ?? 0,
        });
      }
      if (work.turn.completedAt !== null) {
        const child = yield* projections.getThreadRecords(work.threadId, ["turnItems"]);
        yield* writeTools(
          rootTurnId,
          work.turn.id,
          toolGroupsOf(
            child.turnItems.filter((item) => item.providerTurnId === work.turn.id),
            DateTime.toEpochMillis(work.turn.completedAt),
          ),
        );
      }
    }).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("skill usage recording failed", { cause: Cause.pretty(cause) }),
      ),
    );

  const worker = yield* makeDrainableWorker(process);

  const processEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "provider-turn.updated":
        if (
          TERMINAL_STATUSES.has(event.payload.status) &&
          event.payload.turnTokenUsage !== undefined
        ) {
          return worker.enqueue({
            _tag: "turn",
            threadId: event.threadId,
            driver: event.driver,
            turn: event.payload,
          });
        }
        break;
      case "subagent.updated":
        if (TERMINAL_STATUSES.has(event.payload.status) && event.payload.tokenUsage !== undefined) {
          return worker.enqueue({ _tag: "subagent", subagent: event.payload });
        }
        break;
    }
    return Effect.void;
  };

  const readVersionRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SkillVersionRow,
    execute: () => sql`
      SELECT
        i.skill_name AS "skillName",
        i.content_hash AS "contentHash",
        COUNT(*) AS "runs",
        AVG(t.input_tokens) AS "avgInputTokens",
        AVG(t.cached_input_tokens) AS "avgCachedInputTokens",
        AVG(t.output_tokens) AS "avgOutputTokens",
        COUNT(tt.root_turn_id) AS "timedRuns",
        COALESCE(AVG(tt.total_ms), 0) AS "avgTotalMs",
        COALESCE(AVG(tt.model_ms), 0) AS "avgModelMs",
        COALESCE(AVG(tt.tool_ms), 0) AS "avgToolMs",
        COALESCE(AVG(tt.waiting_ms), 0) AS "avgWaitingMs",
        MIN(i.recorded_at) AS "firstSeenAt",
        MAX(i.recorded_at) AS "lastSeenAt"
      FROM skill_invocations i
      JOIN (
        SELECT
          root_turn_id,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(output_tokens) AS output_tokens
        FROM skill_turn_usage
        GROUP BY root_turn_id
      ) t ON t.root_turn_id = i.root_turn_id
      -- Turns recorded before timing existed have no row here.
      LEFT JOIN skill_turn_timing tt ON tt.root_turn_id = i.root_turn_id
      WHERE i.turn_status = 'completed'
      GROUP BY i.skill_name, i.content_hash
    `,
  });

  const readToolRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SkillToolRow,
    execute: () => sql`
      SELECT
        i.skill_name AS "skillName",
        t.kind AS "kind",
        t.label AS "label",
        SUM(t.calls) AS "calls",
        SUM(t.total_ms) AS "totalMs",
        MAX(t.max_ms) AS "maxMs"
      FROM skill_invocations i
      JOIN skill_turn_tools t ON t.root_turn_id = i.root_turn_id
      WHERE i.turn_status = 'completed'
      GROUP BY i.skill_name, t.kind, t.label
    `,
  });

  // A run's share is the sum of its agents'; a run none of them could
  // estimate is left out rather than counted as zero. Averages cover
  // completed runs; the recent total covers every run since `since`.
  const readQuotaRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: SkillQuotaRow,
    execute: (since) => sql`
      SELECT
        i.skill_name AS "skillName",
        i.driver AS "driver",
        COUNT(t.session_percent) FILTER (WHERE i.turn_status = 'completed') AS "sessionRuns",
        COALESCE(AVG(t.session_percent) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgSessionPercent",
        COUNT(t.weekly_percent) FILTER (WHERE i.turn_status = 'completed') AS "weeklyRuns",
        COALESCE(AVG(t.weekly_percent) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgWeeklyPercent",
        COUNT(t.session_percent) FILTER (WHERE i.recorded_at >= ${since}) AS "recentSessionRuns",
        COALESCE(SUM(t.session_percent) FILTER (WHERE i.recorded_at >= ${since}), 0)
          AS "recentSessionPercent"
      FROM skill_invocations i
      JOIN (
        SELECT
          root_turn_id,
          SUM(session_percent) AS session_percent,
          SUM(weekly_percent) AS weekly_percent
        FROM skill_turn_usage
        GROUP BY root_turn_id
      ) t ON t.root_turn_id = i.root_turn_id
      GROUP BY i.skill_name, i.driver
      HAVING "sessionRuns" > 0 OR "weeklyRuns" > 0 OR "recentSessionRuns" > 0
    `,
  });

  const readRecentInvocations = SqlSchema.findAll({
    Request: Schema.String,
    Result: RecentInvocationsRow,
    execute: (since) => sql`
      SELECT skill_name AS "skillName", COUNT(*) AS "invocations"
      FROM skill_invocations
      WHERE recorded_at >= ${since}
      GROUP BY skill_name
    `,
  });

  const readSummary = (input: SkillUsageSummaryInput) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* readVersionRows(undefined);
      const toolRows = yield* readToolRows(undefined);
      const quotaRows = yield* readQuotaRows(
        DateTime.formatIso(DateTime.subtract(now, { days: SKILL_RECENT_SESSION_DAYS })),
      );
      const windows = yield* Effect.forEach(input.usageWindowsDays, (days) =>
        readRecentInvocations(DateTime.formatIso(DateTime.subtract(now, { days }))).pipe(
          Effect.map((windowRows) => ({ days, rows: windowRows })),
        ),
      );
      return summarizeSkillUsage(rows, windows, toolRows, quotaRows, input.tools);
    }).pipe(
      Effect.mapError(
        (cause) => new SkillUsageReadError({ detail: "Could not read skill usage.", cause }),
      ),
    );

  // A turn can run several skills; matching on the turn, not joining, counts
  // its calls once.
  const readCatalogRows = SqlSchema.findAll({
    Request: Schema.NullOr(Schema.String),
    Result: SkillToolCatalogRow,
    execute: (skillName) => sql`
      SELECT
        kind AS "kind",
        label AS "label",
        COUNT(DISTINCT root_turn_id) AS "runs",
        SUM(calls) AS "calls"
      FROM skill_turn_tools
      WHERE root_turn_id IN (
        SELECT root_turn_id FROM skill_invocations
        WHERE turn_status = 'completed' AND (${skillName} IS NULL OR skill_name = ${skillName})
      )
      GROUP BY kind, label
      ORDER BY "runs" DESC, "calls" DESC, label
      LIMIT ${MAX_SKILL_TOOL_CATALOG_ENTRIES}
    `,
  });

  const readToolSkillNames = SqlSchema.findAll({
    Request: Schema.Void,
    Result: SkillNameRow,
    execute: () => sql`
      SELECT DISTINCT i.skill_name AS "skillName"
      FROM skill_invocations i
      WHERE i.turn_status = 'completed'
        AND EXISTS (SELECT 1 FROM skill_turn_tools t WHERE t.root_turn_id = i.root_turn_id)
      ORDER BY i.skill_name
    `,
  });

  const readToolCatalog = (input: SkillToolCatalogInput) =>
    Effect.gen(function* () {
      const tools = yield* readCatalogRows(input.skillName);
      const skillNames = yield* readToolSkillNames(undefined);
      return { skillNames: skillNames.map((row) => row.skillName), tools };
    }).pipe(
      Effect.mapError(
        (cause) => new SkillUsageReadError({ detail: "Could not read skill usage.", cause }),
      ),
    );

  // Averages cover completed runs; the recent total covers every run since
  // `since`, so a version and model can appear for that alone.
  const readBreakdownRows = SqlSchema.findAll({
    Request: Schema.Struct({ skillName: Schema.String, since: Schema.String }),
    Result: SkillBreakdownRow,
    execute: ({ skillName, since }) => sql`
      SELECT
        i.content_hash AS "contentHash",
        NULLIF(i.driver, '') AS "driver",
        i.model AS "model",
        COUNT(*) FILTER (WHERE i.turn_status = 'completed') AS "runs",
        COALESCE(AVG(t.input_tokens) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgInputTokens",
        COALESCE(AVG(t.cached_input_tokens) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgCachedInputTokens",
        COALESCE(AVG(t.output_tokens) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgOutputTokens",
        COUNT(tt.root_turn_id) FILTER (WHERE i.turn_status = 'completed') AS "timedRuns",
        COALESCE(AVG(tt.total_ms) FILTER (WHERE i.turn_status = 'completed'), 0) AS "avgTotalMs",
        COALESCE(AVG(tt.model_ms) FILTER (WHERE i.turn_status = 'completed'), 0) AS "avgModelMs",
        COALESCE(AVG(tt.tool_ms) FILTER (WHERE i.turn_status = 'completed'), 0) AS "avgToolMs",
        COALESCE(AVG(tt.waiting_ms) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgWaitingMs",
        COUNT(t.session_percent) FILTER (WHERE i.turn_status = 'completed') AS "sessionRuns",
        COALESCE(AVG(t.session_percent) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgSessionPercent",
        COUNT(t.weekly_percent) FILTER (WHERE i.turn_status = 'completed') AS "weeklyRuns",
        COALESCE(AVG(t.weekly_percent) FILTER (WHERE i.turn_status = 'completed'), 0)
          AS "avgWeeklyPercent",
        COUNT(t.session_percent) FILTER (WHERE i.recorded_at >= ${since}) AS "recentSessionRuns",
        COALESCE(SUM(t.session_percent) FILTER (WHERE i.recorded_at >= ${since}), 0)
          AS "recentSessionPercent"
      FROM skill_invocations i
      JOIN (
        SELECT
          root_turn_id,
          SUM(input_tokens) AS input_tokens,
          SUM(cached_input_tokens) AS cached_input_tokens,
          SUM(output_tokens) AS output_tokens,
          SUM(session_percent) AS session_percent,
          SUM(weekly_percent) AS weekly_percent
        FROM skill_turn_usage
        GROUP BY root_turn_id
      ) t ON t.root_turn_id = i.root_turn_id
      LEFT JOIN skill_turn_timing tt ON tt.root_turn_id = i.root_turn_id
      WHERE i.skill_name = ${skillName} AND i.content_hash IS NOT NULL
      GROUP BY i.content_hash, i.driver, i.model
      HAVING "runs" > 0 OR "recentSessionRuns" > 0
    `,
  });

  const readVersionPathRows = SqlSchema.findAll({
    Request: Schema.String,
    Result: SkillVersionPathRow,
    execute: (skillName) => sql`
      SELECT
        content_hash AS "contentHash",
        skill_path AS "skillPath",
        MIN(recorded_at) AS "firstSeenAt",
        MAX(recorded_at) AS "lastSeenAt"
      FROM skill_invocations
      WHERE skill_name = ${skillName} AND content_hash IS NOT NULL
      GROUP BY content_hash, skill_path
    `,
  });

  const readDetail = (input: SkillUsageDetailInput) =>
    Effect.gen(function* () {
      const now = yield* DateTime.now;
      const rows = yield* readBreakdownRows({
        skillName: input.skillName,
        since: DateTime.formatIso(DateTime.subtract(now, { days: SKILL_RECENT_SESSION_DAYS })),
      });
      const versionRows = yield* readVersionPathRows(input.skillName);
      const paths = new Set(versionRows.flatMap((row) => row.skillPath ?? []));
      const commitsByPath = new Map(
        yield* Effect.forEach(
          paths,
          (path) =>
            versionCommitsAt(
              vcsProcess,
              pathService.dirname(path),
              pathService.basename(path),
            ).pipe(Effect.map((byHash) => [path, byHash] as const)),
          { concurrency: 4 },
        ),
      );
      return skillUsageDetailOf(input.skillName, rows, versionRows, commitsByPath);
    }).pipe(
      Effect.mapError(
        (cause) => new SkillUsageReadError({ detail: "Could not read skill usage.", cause }),
      ),
    );

  const start = Effect.fn("SkillUsage.start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));
  });

  return SkillUsage.of({
    start,
    drain: worker.drain,
    readSummary,
    readDetail,
    readToolCatalog,
  });
});

export const layer = Layer.effect(SkillUsage, make);
