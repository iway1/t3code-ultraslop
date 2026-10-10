import {
  type ProviderDriverKind,
  SKILL_RECENT_SESSION_DAYS,
  type SkillUsageDetail,
  type SkillVersionModelUsage,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";

/**
 * A metric the skill chart compares. Each breakdown row measures it over some
 * of its runs; a bar averages those, weighted by the runs, or adds them up for
 * a count. Keys match the Skill Monitor's columns.
 */
export interface ChartMetric {
  readonly key: string;
  readonly label: string;
  readonly measure: (row: SkillVersionModelUsage) => { value: number; runs: number };
  readonly format: (value: number) => string;
  readonly count?: true;
  /** What a bar measures, in full, under the chart's title. */
  readonly description: string;
}

const average =
  (
    pick: (row: SkillVersionModelUsage) => number,
    weight: (row: SkillVersionModelUsage) => number,
  ) =>
  (row: SkillVersionModelUsage) => ({ value: pick(row), runs: weight(row) });
const formatShare = (percent: number) => formatPercent(percent / 100, percent >= 1 ? 1 : 2);

export const CHART_METRICS: ReadonlyArray<ChartMetric> = [
  {
    key: "runs",
    label: "Completed runs",
    description: "Number of completed runs of each version",
    measure: (row) => ({ value: row.runs, runs: row.runs }),
    format: String,
    count: true,
  },
  {
    key: "cached",
    label: "Cached tokens",
    description:
      "Cached input tokens, averaged per completed run of each version, subagents included",
    measure: average(
      (row) => row.avgCachedInputTokens,
      (row) => row.runs,
    ),
    format: formatTokens,
  },
  {
    key: "input",
    label: "Input tokens",
    description:
      "Input tokens, cached ones included, averaged per completed run of each version, subagents included",
    measure: average(
      (row) => row.avgInputTokens,
      (row) => row.runs,
    ),
    format: formatTokens,
  },
  {
    key: "output",
    label: "Output tokens",
    description:
      "Output tokens, reasoning included, averaged per completed run of each version, subagents included",
    measure: average(
      (row) => row.avgOutputTokens,
      (row) => row.runs,
    ),
    format: formatTokens,
  },
  {
    key: "session-limit",
    label: "5-hour limit",
    description:
      "Estimated percentage of your 5-hour usage limit, averaged per completed run of each version, subagents included",
    measure: average(
      (row) => row.avgSessionPercent,
      (row) => row.sessionRuns,
    ),
    format: formatShare,
  },
  {
    key: "weekly-limit",
    label: "Weekly limit",
    description:
      "Estimated percentage of your weekly usage limit, averaged per completed run of each version, subagents included",
    measure: average(
      (row) => row.avgWeeklyPercent,
      (row) => row.weeklyRuns,
    ),
    format: formatShare,
  },
  {
    key: "session-limit-recent",
    label: `5-hour limit (${SKILL_RECENT_SESSION_DAYS} days)`,
    measure: (row) => ({ value: row.recentSessionPercent, runs: row.recentSessionRuns }),
    format: formatShare,
    count: true,
    description: `Estimated percentage of your 5-hour usage limit each version used over the last ${SKILL_RECENT_SESSION_DAYS} days, summed across every run, finished or not`,
  },
  {
    key: "total",
    label: "Total time",
    description: "Time from start to finish, averaged per completed run of each version",
    measure: average(
      (row) => row.avgTotalMs,
      (row) => row.timedRuns,
    ),
    format: formatDuration,
  },
  {
    key: "model",
    label: "Model time",
    description: "Time the model spent working, averaged per completed run of each version",
    measure: average(
      (row) => row.avgModelMs,
      (row) => row.timedRuns,
    ),
    format: formatDuration,
  },
  {
    key: "tools",
    label: "Tool time",
    description: "Time spent in tool calls, averaged per completed run of each version",
    measure: average(
      (row) => row.avgToolMs,
      (row) => row.timedRuns,
    ),
    format: formatDuration,
  },
  {
    key: "waiting",
    label: "Waiting time",
    description:
      "Time spent waiting on you for approvals and answers, averaged per completed run of each version",
    measure: average(
      (row) => row.avgWaitingMs,
      (row) => row.timedRuns,
    ),
    format: formatDuration,
  },
];

/** The chart metric a Skill Monitor column shows; recent uses chart as completed runs. */
export function chartMetricForColumn(columnKey: string): ChartMetric | undefined {
  const key = columnKey.startsWith("uses:") ? "runs" : columnKey;
  return CHART_METRICS.find((metric) => metric.key === key);
}

/** The series that combines every model's runs. */
export const ALL_MODELS = "all";

export interface ChartModel {
  readonly key: string;
  readonly driver: ProviderDriverKind | null;
  /** Null for runs recorded before models were. */
  readonly model: string | null;
  readonly runs: number;
}

const modelKey = (row: SkillVersionModelUsage) => `${row.driver ?? ""}\u0000${row.model ?? ""}`;

/** The models the skill ran under, most runs first. */
export function chartModels(detail: SkillUsageDetail): ReadonlyArray<ChartModel> {
  const byKey = new Map<string, ChartModel>();
  for (const row of detail.breakdown) {
    const key = modelKey(row);
    const known = byKey.get(key);
    byKey.set(key, {
      key,
      driver: row.driver,
      model: row.model,
      runs: (known?.runs ?? 0) + row.runs,
    });
  }
  return [...byKey.values()].toSorted(
    (left, right) => right.runs - left.runs || (left.model ?? "").localeCompare(right.model ?? ""),
  );
}

/**
 * One bar: the metric over a version's runs under one model, or under all of
 * them. Null when no run measured it.
 */
export function chartValue(input: {
  readonly detail: SkillUsageDetail;
  readonly metric: ChartMetric;
  readonly contentHash: string;
  readonly series: string;
}): { readonly value: number; readonly runs: number } | null {
  const { metric } = input;
  let total = 0;
  let runs = 0;
  for (const row of input.detail.breakdown) {
    if (row.contentHash !== input.contentHash) continue;
    if (input.series !== ALL_MODELS && modelKey(row) !== input.series) continue;
    const measured = metric.measure(row);
    total += metric.count ? measured.value : measured.value * measured.runs;
    runs += measured.runs;
  }
  if (runs === 0) return null;
  return { value: metric.count ? total : total / runs, runs };
}
