/**
 * Estimates what share of an account's usage limits a run used.
 *
 * Providers report a limit's use only for the whole account, so with threads
 * running side by side no reading of it belongs to one run. Instead the
 * account's burn rate (the limit's use so far over what the account spent in
 * that window, priced from the provider's local transcripts) converts each
 * run's own tokens into a share. Parallel runs then count only their own work.
 *
 * @module usage/skillQuota
 */
import {
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageBucket,
  UsageDay,
  type UsageProviderKind,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

/** Percent of a limit one token of each kind uses. */
export interface QuotaRate {
  readonly input: number;
  readonly cached: number;
  readonly output: number;
}

/** Below this, a window's whole-percent reading is mostly rounding. */
const MIN_CALIBRATION_PERCENT = 2;
const HOURLY_SPEND_MAX_MS = 24 * 60 * 60 * 1000;

/** Each driver's account-wide windows. Model-scoped weeklies are left out. */
const QUOTA_WINDOW_IDS: Readonly<
  Record<
    string,
    { readonly usage: UsageProviderKind; readonly session: string; readonly weekly: string }
  >
> = {
  claudeAgent: { usage: "claude", session: "five_hour", weekly: "seven_day" },
  codex: { usage: "codex", session: "primary", weekly: "secondary" },
};

/** The provider's 5-hour and weekly windows, or undefined when it has neither. */
export function quotaWindowsOf(provider: ServerProvider):
  | {
      readonly usage: UsageProviderKind;
      readonly session: ServerProviderUsageWindow | undefined;
      readonly weekly: ServerProviderUsageWindow | undefined;
    }
  | undefined {
  const ids = QUOTA_WINDOW_IDS[provider.driver];
  const windows = provider.usageLimits?.windows ?? [];
  if (ids === undefined || windows.length === 0) return undefined;
  return {
    usage: ids.usage,
    // Codex's primary window is monthly on Free and Go plans.
    session: windows.find((window) => window.id === ids.session && window.kind === "session"),
    weekly: windows.find((window) => window.id === ids.weekly && window.kind === "weekly"),
  };
}

/**
 * The usage read covering the window from its start until now: hourly when it
 * fits the hourly limit, else whole UTC days, which may take in part of the day
 * before the window. Undefined when the window's bounds are unknown or it has
 * already reset, since its reading is then stale.
 */
export function spendQueryOf(
  window: ServerProviderUsageWindow,
  now: DateTime.Utc,
): UsageSummaryInput | undefined {
  const resetsAt = window.resetsAt === undefined ? Option.none() : DateTime.make(window.resetsAt);
  if (Option.isNone(resetsAt) || window.windowDurationMins === undefined) return undefined;
  const resetsAtMs = DateTime.toEpochMillis(resetsAt.value);
  const startMs = resetsAtMs - window.windowDurationMins * 60_000;
  const nowMs = DateTime.toEpochMillis(now);
  if (nowMs >= resetsAtMs || nowMs <= startMs) return undefined;
  const start = DateTime.makeUnsafe(startMs);
  const days = {
    sinceDay: UsageDay.make(DateTime.formatIsoDateUtc(start)),
    untilDay: UsageDay.make(DateTime.formatIsoDateUtc(now)),
    timeZone: "UTC",
  };
  return nowMs - startMs <= HOURLY_SPEND_MAX_MS
    ? {
        ...days,
        resolution: "hour",
        sinceTime: DateTime.formatIso(start),
        untilTime: DateTime.formatIso(now),
      }
    : days;
}

/**
 * The rate a window's `usedPercent` implies for the spend in `buckets`, the
 * provider's usage since the window began. Each token kind is priced at what
 * it cost on average there, so the account's own model mix sets the prices.
 * Null when there is too little to estimate from.
 */
export function quotaRateOf(
  usedPercent: number,
  buckets: ReadonlyArray<UsageBucket>,
): QuotaRate | null {
  if (usedPercent < MIN_CALIBRATION_PERCENT) return null;
  let spentUsd = 0;
  const tokens = { input: 0, cached: 0, output: 0 };
  const costUsd = { input: 0, cached: 0, output: 0 };
  for (const bucket of buckets) {
    spentUsd += bucket.costUsd;
    const split = bucket.categoryCostUsd;
    if (split === undefined) continue;
    tokens.input += bucket.totals.uncachedInputTokens + bucket.totals.cacheCreationTokens;
    tokens.cached += bucket.totals.cachedInputTokens;
    tokens.output += bucket.totals.outputTokens;
    costUsd.input += split.input + split.cacheWrite;
    costUsd.cached += split.cacheRead;
    costUsd.output += split.output;
  }
  if (spentUsd <= 0 || costUsd.input + costUsd.cached + costUsd.output <= 0) return null;
  const percentPerUsd = usedPercent / spentUsd;
  const rate = (kind: keyof QuotaRate) =>
    tokens[kind] === 0 ? 0 : (costUsd[kind] / tokens[kind]) * percentPerUsd;
  return { input: rate("input"), cached: rate("cached"), output: rate("output") };
}

/** A run's share of a limit, in percent. Input tokens include the cached ones. */
export function quotaPercentOf(
  rate: QuotaRate,
  usage: {
    readonly inputTokens: number;
    readonly cachedInputTokens: number;
    readonly outputTokens: number;
  },
): number {
  return (
    Math.max(0, usage.inputTokens - usage.cachedInputTokens) * rate.input +
    usage.cachedInputTokens * rate.cached +
    usage.outputTokens * rate.output
  );
}
