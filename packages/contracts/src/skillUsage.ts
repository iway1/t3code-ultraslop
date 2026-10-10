import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * Averages over the completed turns a skill ran in. Tokens count the subagents
 * those turns started; input counts cache reads and writes, output counts
 * reasoning. Time splits each turn's wall clock between the model, its tool
 * calls, and waiting on the user, over the `timedRuns` that recorded it.
 */
const SkillUsageAverageFields = {
  runs: NonNegativeInt,
  avgInputTokens: Schema.Number,
  avgCachedInputTokens: Schema.Number,
  avgOutputTokens: Schema.Number,
  timedRuns: NonNegativeInt,
  avgTotalMs: Schema.Number,
  avgModelMs: Schema.Number,
  avgToolMs: Schema.Number,
  avgWaitingMs: Schema.Number,
};

export const SkillToolKind = Schema.Literals([
  "command",
  "edit",
  "search",
  "web",
  "tool",
  "subagent",
]);
export type SkillToolKind = typeof SkillToolKind.Type;

/**
 * One tool, or one command grouped by what it runs (`pnpm test`), across a
 * skill's completed turns and their subagents. Calls can overlap, so these
 * add up to more than the turns' tool time.
 */
export const SkillToolUsage = Schema.Struct({
  kind: SkillToolKind,
  label: TrimmedNonEmptyString,
  calls: NonNegativeInt,
  totalMs: Schema.Number,
  maxMs: Schema.Number,
});
export type SkillToolUsage = typeof SkillToolUsage.Type;

export const MAX_SKILL_SLOWEST_TOOLS = 5;

/** A tool or command group, as `SkillToolUsage` names it. */
export const SkillToolRef = Schema.Struct({
  kind: SkillToolKind,
  label: TrimmedNonEmptyString,
});
export type SkillToolRef = typeof SkillToolRef.Type;

export const MAX_SKILL_TOOL_COLUMNS = 8;

export const MIN_SKILL_USAGE_WINDOW_DAYS = 1;
export const MAX_SKILL_USAGE_WINDOW_DAYS = 365;
export const MAX_SKILL_USAGE_WINDOWS = 6;
export const SkillUsageWindowDays = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_SKILL_USAGE_WINDOW_DAYS,
    maximum: MAX_SKILL_USAGE_WINDOW_DAYS,
  }),
);
export type SkillUsageWindowDays = typeof SkillUsageWindowDays.Type;

export const SkillUsageSummaryInput = Schema.Struct({
  /** Look-back windows, in days, to count each skill's uses over. */
  usageWindowsDays: Schema.Array(SkillUsageWindowDays).check(
    Schema.isMaxLength(MAX_SKILL_USAGE_WINDOWS),
  ),
  /** Tools to report for every skill, whatever their rank. */
  tools: Schema.Array(SkillToolRef)
    .check(Schema.isMaxLength(MAX_SKILL_TOOL_COLUMNS))
    .pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SkillUsageSummaryInput = typeof SkillUsageSummaryInput.Type;

/** Turns the skill ran in over the last `days` days, finished or not. */
export const SkillUsageWindowCount = Schema.Struct({
  days: SkillUsageWindowDays,
  invocations: NonNegativeInt,
});
export type SkillUsageWindowCount = typeof SkillUsageWindowCount.Type;

/** One version of a skill, identified by the SHA-256 of its `SKILL.md`. */
export const SkillVersionUsage = Schema.Struct({
  contentHash: TrimmedNonEmptyString,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  ...SkillUsageAverageFields,
});
export type SkillVersionUsage = typeof SkillVersionUsage.Type;

/** How far back the Skill Monitor totals 5-hour limit shares. */
export const SKILL_RECENT_SESSION_DAYS = 7;

/**
 * The 5-hour limit shares of the last `SKILL_RECENT_SESSION_DAYS` days, added
 * up over every run that could be estimated, finished or not. Older servers
 * send neither.
 */
const SkillRecentSessionFields = {
  recentSessionRuns: NonNegativeInt.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
  recentSessionPercent: Schema.Number.pipe(Schema.withDecodingDefault(Effect.succeed(0))),
};

/**
 * Estimated share of the account's 5-hour and weekly usage limits an average
 * completed run used, subagents included, over the runs of one driver that
 * could be estimated. Each run's tokens are priced at the rate its account was
 * using the limit when it finished, so runs in parallel each count only their
 * own work.
 */
export const SkillQuotaUsage = Schema.Struct({
  driver: ProviderDriverKind,
  sessionRuns: NonNegativeInt,
  avgSessionPercent: Schema.Number,
  weeklyRuns: NonNegativeInt,
  avgWeeklyPercent: Schema.Number,
  ...SkillRecentSessionFields,
});
export type SkillQuotaUsage = typeof SkillQuotaUsage.Type;

/** All-time usage of the skills with this name, newest version first. */
export const SkillUsage = Schema.Struct({
  skillName: TrimmedNonEmptyString,
  ...SkillUsageAverageFields,
  /** One count per requested window, in request order. */
  recentUses: Schema.Array(SkillUsageWindowCount),
  /** The tools with the most total time, slowest first. */
  slowestTools: Schema.Array(SkillToolUsage),
  /** The requested `tools` this skill's runs called. Absent from older servers. */
  tools: Schema.Array(SkillToolUsage).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  versions: Schema.Array(SkillVersionUsage),
  /** One entry per driver with estimated runs. Absent from older servers. */
  quota: Schema.Array(SkillQuotaUsage).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});
export type SkillUsage = typeof SkillUsage.Type;

export const SkillUsageSummary = Schema.Struct({
  skills: Schema.Array(SkillUsage),
});
export type SkillUsageSummary = typeof SkillUsageSummary.Type;

export const MAX_SKILL_TOOL_CATALOG_ENTRIES = 1000;

export const SkillToolCatalogInput = Schema.Struct({
  /** Only the tools this skill's runs called; every skill's when null. */
  skillName: Schema.NullOr(TrimmedNonEmptyString),
});
export type SkillToolCatalogInput = typeof SkillToolCatalogInput.Type;

/** A tool, with the completed skill runs that called it and its calls across them. */
export const SkillToolCatalogEntry = Schema.Struct({
  kind: SkillToolKind,
  label: TrimmedNonEmptyString,
  runs: NonNegativeInt,
  calls: NonNegativeInt,
});
export type SkillToolCatalogEntry = typeof SkillToolCatalogEntry.Type;

/**
 * The tools completed skill runs called, in most runs first, to pick Skill
 * Monitor columns from, and the skills that called any.
 */
export const SkillToolCatalog = Schema.Struct({
  skillNames: Schema.Array(TrimmedNonEmptyString),
  tools: Schema.Array(SkillToolCatalogEntry),
});
export type SkillToolCatalog = typeof SkillToolCatalog.Type;

export const SkillUsageDetailInput = Schema.Struct({
  skillName: TrimmedNonEmptyString,
});
export type SkillUsageDetailInput = typeof SkillUsageDetailInput.Type;

/** The oldest commit whose SKILL.md matches a version, for skills kept in git. */
export const SkillVersionCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  subject: Schema.String,
  committedAt: IsoDateTime,
});
export type SkillVersionCommit = typeof SkillVersionCommit.Type;

/** A version of a skill, with its commit when one has the same SKILL.md. */
export const SkillVersionLabel = Schema.Struct({
  contentHash: TrimmedNonEmptyString,
  firstSeenAt: IsoDateTime,
  lastSeenAt: IsoDateTime,
  commit: Schema.NullOr(SkillVersionCommit),
});
export type SkillVersionLabel = typeof SkillVersionLabel.Type;

/**
 * Averages over the completed runs of one version under one model: the model
 * the run started with, null for runs recorded before models were. Usage-limit
 * shares average over the runs that could be estimated, as in `SkillQuotaUsage`.
 */
export const SkillVersionModelUsage = Schema.Struct({
  contentHash: TrimmedNonEmptyString,
  driver: Schema.NullOr(ProviderDriverKind),
  model: Schema.NullOr(TrimmedNonEmptyString),
  ...SkillUsageAverageFields,
  sessionRuns: NonNegativeInt,
  avgSessionPercent: Schema.Number,
  weeklyRuns: NonNegativeInt,
  avgWeeklyPercent: Schema.Number,
  ...SkillRecentSessionFields,
});
export type SkillVersionModelUsage = typeof SkillVersionModelUsage.Type;

/** One skill's completed runs split by version and model, oldest version first. */
export const SkillUsageDetail = Schema.Struct({
  skillName: TrimmedNonEmptyString,
  versions: Schema.Array(SkillVersionLabel),
  breakdown: Schema.Array(SkillVersionModelUsage),
});
export type SkillUsageDetail = typeof SkillUsageDetail.Type;

/**
 * Switch a skill on or off by name in the provider's user-wide config, so it
 * applies to every project. The name must be in the provider's skill
 * inventory; `cwd` is the folder the change came from. It takes effect from
 * the next agent session.
 */
export const SetSkillEnabledInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  cwd: TrimmedNonEmptyString,
  skillName: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type SetSkillEnabledInput = typeof SetSkillEnabledInput.Type;

export class SkillToggleError extends Schema.TaggedError<SkillToggleError>()("SkillToggleError", {
  /** Stable, bounded description. The underlying failure travels in `cause`. */
  detail: TrimmedNonEmptyString,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return this.detail;
  }
}

export class SkillUsageReadError extends Schema.TaggedError<SkillUsageReadError>()(
  "SkillUsageReadError",
  {
    /** Stable, bounded description. The underlying failure travels in `cause`. */
    detail: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Skill usage read failed: ${this.detail}`;
  }
}
