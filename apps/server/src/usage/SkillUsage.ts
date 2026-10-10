/**
 * SkillUsage - records the skills each user turn ran and the tokens it used,
 * its subagents included, and answers per-skill averages for the Skill Monitor.
 *
 * A user turn is a provider turn with a run attempt. Subagent work rolls up to
 * the user turn that launched it: Codex reports usage on each subagent provider
 * turn, Claude on the subagent's terminal `subagent.updated`. Each agent's
 * usage is its own row, replaced on repeat, so late subagents still count and
 * nothing counts twice.
 *
 * @module usage/SkillUsage
 */
import * as NodeCrypto from "node:crypto";

import {
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type ProviderDriverKind,
  type ProviderTurnId,
  type ServerProvider,
  MAX_SKILL_SLOWEST_TOOLS,
  SkillToolKind,
  SkillUsageReadError,
  type SkillUsageSummary,
  type SkillUsageSummaryInput,
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
import { type ToolGroup, type TurnTiming, toolGroupsOf, turnTimingOf } from "./skillTiming.ts";

export class SkillUsage extends Context.Service<
  SkillUsage,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
    readonly readSummary: (
      input: SkillUsageSummaryInput,
    ) => Effect.Effect<SkillUsageSummary, SkillUsageReadError>;
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
 * first, with its slowest tools. A skill whose recent turns all stopped early
 * still appears, with no completed runs.
 */
export function summarizeSkillUsage(
  rows: ReadonlyArray<SkillVersionRow>,
  windows: ReadonlyArray<{
    readonly days: number;
    readonly rows: ReadonlyArray<RecentInvocationsRow>;
  }>,
  toolRows: ReadonlyArray<SkillToolRow>,
): SkillUsageSummary {
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
        .map(({ kind, label, calls, totalMs, maxMs }) => ({ kind, label, calls, totalMs, maxMs })),
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
    })),
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
  const fileSystem = yield* FileSystem.FileSystem;
  const sql = yield* SqlClient.SqlClient;

  const writePart = (input: {
    readonly rootTurnId: ProviderTurnId;
    readonly partId: string;
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  }) =>
    Effect.gen(function* () {
      const recordedAt = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT OR REPLACE INTO skill_turn_usage (
          root_turn_id, part_id, input_tokens, cached_input_tokens, output_tokens, recorded_at
        ) VALUES (
          ${input.rootTurnId}, ${input.partId}, ${input.inputTokens},
          ${input.cachedInputTokens}, ${input.outputTokens}, ${recordedAt}
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
  ): Effect.Effect<ProviderTurnId | null, ProjectionStore.ProjectionStoreV2Error> =>
    Effect.gen(function* () {
      if (depth > MAX_ROLLUP_DEPTH) return null;
      const records = yield* projections.getThreadRecords(threadId, ["providerTurns", "subagents"]);
      // A run's root node carries its turn; subagent provider turns have no run attempt.
      const turn = records.providerTurns.findLast((candidate) => candidate.nodeId === nodeId);
      if (turn !== undefined && turn.runAttemptId !== null) return turn.id;
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
    const usage = turn.turnTokenUsage;
    if (usage !== undefined && usage.usageStatus !== "unavailable") {
      yield* writePart({
        rootTurnId: turn.id,
        partId: turn.id,
        inputTokens: usage.inputTokens ?? 0,
        cachedInputTokens: usage.cachedInputTokens ?? 0,
        outputTokens: usage.outputTokens ?? 0,
      });
    }

    const records = yield* projections.getThreadRecords(threadId, ["attempts", "runs"]);
    const attempt = records.attempts.find((candidate) => candidate.id === turn.runAttemptId);
    const run = records.runs.find((candidate) => candidate.id === attempt?.runId);
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
              root_turn_id, skill_name, thread_id, driver, skill_path, content_hash,
              source, turn_status, recorded_at
            ) VALUES (
              ${turn.id}, ${skillName}, ${threadId}, ${driver ?? provider?.driver ?? ""},
              ${path}, ${contentHash}, ${source}, ${turn.status}, ${recordedAt}
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
        const usage = subagent.tokenUsage;
        if (usage === undefined) return;
        const rootTurnId = yield* findUserTurn(subagent.threadId, subagent.parentNodeId, 0);
        if (rootTurnId === null) return;
        yield* writePart({ rootTurnId, partId: subagent.id, ...usage });
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
      const rootTurnId = yield* findUserTurn(work.threadId, work.turn.nodeId, 0);
      if (rootTurnId === null) return;
      const usage = work.turn.turnTokenUsage;
      if (usage !== undefined && usage.usageStatus !== "unavailable") {
        yield* writePart({
          rootTurnId,
          partId: work.turn.id,
          inputTokens: usage.inputTokens ?? 0,
          cachedInputTokens: usage.cachedInputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
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
      const windows = yield* Effect.forEach(input.usageWindowsDays, (days) =>
        readRecentInvocations(DateTime.formatIso(DateTime.subtract(now, { days }))).pipe(
          Effect.map((windowRows) => ({ days, rows: windowRows })),
        ),
      );
      return summarizeSkillUsage(rows, windows, toolRows);
    }).pipe(
      Effect.mapError(
        (cause) => new SkillUsageReadError({ detail: "Could not read skill usage.", cause }),
      ),
    );

  const start = Effect.fn("SkillUsage.start")(function* () {
    yield* forkParked(Stream.runForEach(orchestrator.streamDomainEvents, processEvent));
  });

  return SkillUsage.of({ start, drain: worker.drain, readSummary });
});

export const layer = Layer.effect(SkillUsage, make);
