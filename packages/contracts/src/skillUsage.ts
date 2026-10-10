import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

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

/** All-time usage of the skills with this name, newest version first. */
export const SkillUsage = Schema.Struct({
  skillName: TrimmedNonEmptyString,
  ...SkillUsageAverageFields,
  /** One count per requested window, in request order. */
  recentUses: Schema.Array(SkillUsageWindowCount),
  /** The tools with the most total time, slowest first. */
  slowestTools: Schema.Array(SkillToolUsage),
  versions: Schema.Array(SkillVersionUsage),
});
export type SkillUsage = typeof SkillUsage.Type;

export const SkillUsageSummary = Schema.Struct({
  skills: Schema.Array(SkillUsage),
});
export type SkillUsageSummary = typeof SkillUsageSummary.Type;

/**
 * Switch a skill on or off in the provider's user-wide config, so it applies
 * to every project. The skill is looked up by name in the provider's own list
 * for `cwd`. It takes effect from the next agent session.
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
