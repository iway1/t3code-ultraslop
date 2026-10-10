import { assert, describe, it } from "@effect/vitest";
import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { commandLabel, toolGroupsOf, turnTimingOf } from "./skillTiming.ts";

const second = 1_000;

const item = (
  fields: Record<string, unknown>,
  startS: number | null,
  endS: number | null,
): OrchestrationV2TurnItem =>
  ({
    ...fields,
    startedAt: startS === null ? null : DateTime.makeUnsafe(startS * second),
    completedAt: endS === null ? null : DateTime.makeUnsafe(endS * second),
  }) as unknown as OrchestrationV2TurnItem;

const command = (input: string, startS: number, endS: number | null) =>
  item({ type: "command_execution", input }, startS, endS);

describe("commandLabel", () => {
  it("groups commands by what they run", () => {
    assert.deepStrictEqual(
      [
        "pnpm test --filter web",
        "/bin/zsh -lc 'pnpm test'",
        "cd apps/web && CI=1 vp test run src",
        "git status",
        "./scripts/build.sh --fast",
        "ls -la",
      ].map(commandLabel),
      ["pnpm test", "pnpm test", "vp test", "git status", "build.sh", "ls"],
    );
  });

  it("names scripts by their file and keeps what a runner runs", () => {
    assert.deepStrictEqual(
      [
        "node scripts/mobile-native-client.ts ensure ios",
        "npx tsx /Users/me/repo/.worktrees/a/scripts/gen.ts --out x",
        "python3 -u tools/build.py",
        "uv run python tools/build.py",
        "node -e 'console.log(1)'",
        "pnpm run build:web",
        "vp run dev",
        "uv run pytest -x",
        "cargo run --bin server",
        "python -m pytest -x",
        "node scripts/check.ts | tail -20",
      ].map(commandLabel),
      [
        "mobile-native-client.ts ensure",
        "gen.ts",
        "build.py",
        "build.py",
        "node",
        "pnpm run build:web",
        "vp run dev",
        "uv run pytest",
        "cargo run",
        "python -m pytest",
        "check.ts",
      ],
    );
  });

  it("does not take a pattern or path for a subcommand", () => {
    assert.deepStrictEqual(
      ["rg somePattern src", "cat foo.ts", "ls src", "gh pr view 12"].map(commandLabel),
      ["rg", "cat", "ls", "gh pr"],
    );
  });
});

describe("turnTimingOf", () => {
  it("splits wall time between the model, merged tool spans, and the user", () => {
    const timing = turnTimingOf(
      [
        // Two overlapping commands block the model for 20s, not 25s.
        command("pnpm test", 10, 25),
        command("pnpm lint", 15, 30),
        // The approval inside this command is the user's time, not the tool's.
        command("rm -rf dist", 40, 50),
        item({ type: "approval_request" }, 40, 46),
        // Still running when the turn ended: counts up to the turn's end.
        item({ type: "dynamic_tool", toolName: "Browser" }, 90, null),
        item({ type: "assistant_message" }, 0, 100),
      ],
      { start: 0, end: 100 * second },
    );
    assert.deepStrictEqual(timing, {
      wallMs: 100 * second,
      toolMs: (20 + 4 + 10) * second,
      waitingMs: 6 * second,
      modelMs: (100 - 34 - 6) * second,
    });
  });
});

describe("toolGroupsOf", () => {
  it("keeps each call's own time, less any wait on the user", () => {
    const groups = toolGroupsOf(
      [
        command("pnpm test", 0, 30),
        command("pnpm test --watch=false", 40, 50),
        command("rm -rf dist", 60, 70),
        item({ type: "approval_request" }, 60, 66),
        item({ type: "subagent", title: "  " }, 0, 20),
      ],
      100 * second,
    );
    assert.deepStrictEqual(groups, [
      { kind: "command", label: "pnpm test", calls: 2, totalMs: 40 * second, maxMs: 30 * second },
      { kind: "command", label: "rm", calls: 1, totalMs: 4 * second, maxMs: 4 * second },
      { kind: "subagent", label: "Subagent", calls: 1, totalMs: 20 * second, maxMs: 20 * second },
    ]);
  });
});
