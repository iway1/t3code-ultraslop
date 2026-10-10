import { assert, describe, it } from "@effect/vitest";
import {
  type ServerProvider,
  type ServerProviderUsageWindow,
  type UsageBucket,
  UsageDay,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { quotaRateOf, quotaWindowsOf, spendQueryOf } from "./skillQuota.ts";

const hour = 60 * 60 * 1000;
const now = DateTime.makeUnsafe("2026-10-10T12:00:00.000Z");

const window = (
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  windowDurationMins: number,
  resetsInMs: number,
): ServerProviderUsageWindow => ({
  id,
  kind,
  label: id,
  usedPercent: 40,
  windowDurationMins,
  resetsAt: DateTime.formatIso(DateTime.makeUnsafe(DateTime.toEpochMillis(now) + resetsInMs)),
});

const bucket = (costUsd: number, split: boolean) =>
  ({
    totals: {
      uncachedInputTokens: 1_000,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    },
    costUsd,
    ...(split
      ? { categoryCostUsd: { input: costUsd, cacheRead: 0, cacheWrite: 0, output: 0 } }
      : {}),
  }) as unknown as UsageBucket;

describe("quotaWindowsOf", () => {
  it("takes the account-wide windows and leaves model-scoped and monthly ones out", () => {
    const codex = {
      driver: "codex",
      usageLimits: { windows: [window("primary", "monthly", 43_200, hour)] },
    } as unknown as ServerProvider;
    assert.deepStrictEqual(quotaWindowsOf(codex)?.session, undefined);

    const claude = {
      driver: "claudeAgent",
      usageLimits: {
        windows: [
          window("five_hour", "session", 300, hour),
          window("seven_day_opus", "weekly", 10_080, hour),
          window("seven_day", "weekly", 10_080, hour),
        ],
      },
    } as unknown as ServerProvider;
    const windows = quotaWindowsOf(claude);
    assert.strictEqual(windows?.usage, "claude");
    assert.strictEqual(windows?.session?.id, "five_hour");
    assert.strictEqual(windows?.weekly?.id, "seven_day");
  });
});

describe("spendQueryOf", () => {
  it("reads the 5-hour window by the hour and the weekly one by the day", () => {
    assert.deepStrictEqual(spendQueryOf(window("five_hour", "session", 300, 2 * hour), now), {
      sinceDay: UsageDay.make("2026-10-10"),
      untilDay: UsageDay.make("2026-10-10"),
      timeZone: "UTC",
      resolution: "hour",
      sinceTime: "2026-10-10T09:00:00.000Z",
      untilTime: "2026-10-10T12:00:00.000Z",
    });
    assert.deepStrictEqual(spendQueryOf(window("seven_day", "weekly", 10_080, 24 * hour), now), {
      sinceDay: UsageDay.make("2026-10-04"),
      untilDay: UsageDay.make("2026-10-10"),
      timeZone: "UTC",
    });
  });

  it("skips a window that has already reset", () => {
    assert.strictEqual(spendQueryOf(window("five_hour", "session", 300, -hour), now), undefined);
  });
});

describe("quotaRateOf", () => {
  it("spreads the window's use over everything spent in it", () => {
    // 40% for $8, half of it unsplit: input tokens are priced at $4 per 1,000.
    const rate = quotaRateOf(40, [bucket(4, true), bucket(4, false)]);
    assert.closeTo(rate?.input ?? -1, (4 / 1_000) * 5, 1e-12);
  });

  it("does not estimate from a barely used window or no priced spend", () => {
    assert.strictEqual(quotaRateOf(1, [bucket(4, true)]), null);
    assert.strictEqual(quotaRateOf(40, [bucket(4, false)]), null);
    assert.strictEqual(quotaRateOf(40, []), null);
  });
});
