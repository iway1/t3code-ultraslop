import {
  ProviderDriverKind,
  type SkillUsageDetail,
  type SkillVersionModelUsage,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ALL_MODELS,
  CHART_METRICS,
  chartMetricForColumn,
  chartModels,
  chartValue,
} from "./skillUsageChart";

const claude = ProviderDriverKind.make("claudeAgent");
const codex = ProviderDriverKind.make("codex");

const row = (
  contentHash: string,
  driver: ProviderDriverKind,
  model: string | null,
  fields: Partial<SkillVersionModelUsage>,
): SkillVersionModelUsage => ({
  contentHash,
  driver,
  model,
  runs: 0,
  avgInputTokens: 0,
  avgCachedInputTokens: 0,
  avgOutputTokens: 0,
  timedRuns: 0,
  avgTotalMs: 0,
  avgModelMs: 0,
  avgToolMs: 0,
  avgWaitingMs: 0,
  sessionRuns: 0,
  avgSessionPercent: 0,
  weeklyRuns: 0,
  avgWeeklyPercent: 0,
  recentSessionRuns: 0,
  recentSessionPercent: 0,
  ...fields,
});

const detail: SkillUsageDetail = {
  skillName: "review",
  versions: [],
  breakdown: [
    row("v1", claude, "opus", {
      runs: 3,
      avgInputTokens: 1_000,
      timedRuns: 1,
      avgTotalMs: 60_000,
      recentSessionRuns: 2,
      recentSessionPercent: 6,
    }),
    row("v1", codex, "gpt", {
      runs: 1,
      avgInputTokens: 5_000,
      timedRuns: 1,
      avgTotalMs: 20_000,
      sessionRuns: 1,
      avgSessionPercent: 40,
      recentSessionRuns: 1,
      recentSessionPercent: 30,
    }),
    row("v1", claude, "sonnet", {
      runs: 2,
      avgInputTokens: 500,
      sessionRuns: 2,
      avgSessionPercent: 4,
      recentSessionRuns: 1,
      recentSessionPercent: 1.5,
    }),
    row("v2", claude, null, { runs: 4, avgInputTokens: 2_000 }),
  ],
};
const metric = (key: string) => CHART_METRICS.find((candidate) => candidate.key === key)!;
const value = (key: string, contentHash: string, series: string) =>
  chartValue({ detail, metric: metric(key), contentHash, series });

describe("skill usage chart", () => {
  it("weights each model's averages by the runs that measured them", () => {
    // (3 × 1,000 + 5,000 + 2 × 500) / 6 runs.
    expect(value("input", "v1", ALL_MODELS)).toEqual({ value: 1_500, runs: 6 });
    // Only two runs were timed.
    expect(value("total", "v1", ALL_MODELS)).toEqual({ value: 40_000, runs: 2 });
    expect(value("runs", "v1", ALL_MODELS)).toEqual({ value: 6, runs: 6 });
  });

  it("charts one model's runs on its own, and nothing where it did not run", () => {
    const opus = chartModels(detail).find((model) => model.model === "opus");
    expect(value("input", "v1", opus!.key)).toEqual({ value: 1_000, runs: 3 });
    expect(value("input", "v2", opus!.key)).toBeNull();
  });

  it("averages usage-limit shares over every model's runs", () => {
    // (40 + 2 × 4) / 3 runs, Codex's included.
    expect(value("session-limit", "v1", ALL_MODELS)).toEqual({ value: 16, runs: 3 });
    const gpt = chartModels(detail).find((model) => model.model === "gpt");
    expect(value("session-limit", "v1", gpt!.key)).toEqual({ value: 40, runs: 1 });
  });

  it("adds up recent 5-hour shares rather than averaging them", () => {
    // Opus's 6%, Codex's 30%, and Sonnet's 1.5%.
    expect(value("session-limit-recent", "v1", ALL_MODELS)).toEqual({ value: 37.5, runs: 4 });
    expect(chartMetricForColumn("session-limit-recent")?.key).toBe("session-limit-recent");
  });

  it("lists models by runs across versions", () => {
    expect(chartModels(detail).map((model) => [model.model, model.runs])).toEqual([
      [null, 4],
      ["opus", 3],
      ["sonnet", 2],
      ["gpt", 1],
    ]);
  });

  it("charts recent uses as completed runs and skips columns with no history", () => {
    expect(chartMetricForColumn("uses:7")?.key).toBe("runs");
    expect(chartMetricForColumn("total")?.key).toBe("total");
    expect(chartMetricForColumn("ambient")).toBeUndefined();
  });
});
