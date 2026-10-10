import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  type ServerProvider,
  ThreadId,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { SkillUsage, layer, skillsUsedInTurn } from "./SkillUsage.ts";

const instanceId = ProviderInstanceId.make("claude");
const driver = ProviderDriverKind.make("claude");
const threadId = ThreadId.make("thread:main");
const childThreadId = ThreadId.make("thread:child");
const reviewPath = "/repo/.claude/skills/review/SKILL.md";
const deployPath = "/repo/.claude/skills/deploy/SKILL.md";

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

const usage = (inputTokens: number, cachedInputTokens: number, outputTokens: number) =>
  ({
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens,
    cachedInputTokens,
    outputTokens,
  }) satisfies TurnTokenUsage;

const at = (ms: number) => DateTime.makeUnsafe(ms);

/** A user turn: run, attempt, and the provider turn rooted at the run's node. */
const userTurn = (
  ordinal: number,
  status: OrchestrationV2ProviderTurn["status"],
  span?: readonly [number, number],
) => ({
  run: { id: RunId.make(`run:${ordinal}`), providerInstanceId: instanceId },
  attempt: { id: RunAttemptId.make(`attempt:${ordinal}`), runId: RunId.make(`run:${ordinal}`) },
  turn: {
    id: ProviderTurnId.make(`turn:${ordinal}`),
    nodeId: NodeId.make(`root:${ordinal}`),
    runAttemptId: RunAttemptId.make(`attempt:${ordinal}`),
    status,
    startedAt: span === undefined ? null : at(span[0]),
    completedAt: span === undefined ? null : at(span[1]),
  },
});
const first = userTurn(1, "completed", [0, 60_000]);
const interrupted = userTurn(2, "interrupted");
const third = userTurn(3, "completed");

const turnEvent = (
  turnThreadId: ThreadId,
  turn: Partial<OrchestrationV2ProviderTurn>,
  turnTokenUsage: TurnTokenUsage,
) =>
  ({
    type: "provider-turn.updated",
    threadId: turnThreadId,
    driver,
    payload: { ...turn, turnTokenUsage },
  }) as unknown as OrchestrationV2DomainEvent;

const claudeSubagent = {
  id: NodeId.make("subagent:claude"),
  threadId,
  parentNodeId: first.turn.nodeId,
  childThreadId: null,
  status: "completed",
  tokenUsage: { inputTokens: 1_000, cachedInputTokens: 800, outputTokens: 100 },
} as unknown as OrchestrationV2Subagent;

const ownThreadSubagent = {
  id: NodeId.make("subagent:own-thread"),
  threadId,
  parentNodeId: first.turn.nodeId,
  childThreadId,
  status: "completed",
} as unknown as OrchestrationV2Subagent;

const childTurn = {
  id: ProviderTurnId.make("turn:child"),
  nodeId: NodeId.make("root:child"),
  runAttemptId: null,
  status: "completed",
  startedAt: at(60_000),
  completedAt: at(70_000),
} as const;

const projections = new Map<ThreadId, OrchestrationV2ThreadProjection>([
  [
    threadId,
    {
      thread: {
        id: threadId,
        projectId: ProjectId.make("project"),
        worktreePath: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
      },
      runs: [first.run, interrupted.run, third.run],
      attempts: [first.attempt, interrupted.attempt, third.attempt],
      providerTurns: [first.turn, interrupted.turn, third.turn],
      subagents: [claudeSubagent, ownThreadSubagent],
      turnItems: [
        {
          type: "dynamic_tool",
          providerTurnId: first.turn.id,
          toolName: "Skill",
          input: { skill: "deploy" },
          startedAt: null,
          completedAt: null,
        },
        {
          type: "command_execution",
          providerTurnId: first.turn.id,
          input: "pnpm test",
          startedAt: at(10_000),
          completedAt: at(40_000),
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection,
  ],
  [
    childThreadId,
    {
      thread: {
        id: childThreadId,
        lineage: {
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        },
      },
      providerTurns: [childTurn],
      subagents: [],
      turnItems: [
        {
          type: "command_execution",
          providerTurnId: childTurn.id,
          input: "pnpm test --filter api",
          startedAt: at(61_000),
          completedAt: at(66_000),
        },
      ],
    } as unknown as OrchestrationV2ThreadProjection,
  ],
]);

const messages = new Map<RunId, string>([
  // `$20` is prose, not a skill.
  [first.run.id, "Use $review on this, it costs $20"],
  [interrupted.run.id, "$review again"],
  [third.run.id, "/review the follow-up"],
]);

const makeHarness = Effect.gen(function* () {
  const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
  const messageReads = yield* Queue.unbounded<RunId>();
  const files = new Map([
    [reviewPath, "review v1"],
    [deployPath, "deploy v1"],
  ]);
  const provider = {
    instanceId,
    driver,
    skills: [
      { name: "review", path: reviewPath, enabled: true },
      { name: "deploy", path: deployPath, enabled: true },
    ],
  } as unknown as ServerProvider;

  const dependencies = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThreadRecords: (id: ThreadId) => Effect.succeed(projections.get(id)!),
      getRunMessage: (_threadId, runId) =>
        Queue.offer(messageReads, runId).pipe(
          Effect.as({ text: messages.get(runId) ?? "" } as never),
        ),
    }),
    Layer.mock(ProjectStore.ProjectStoreV2)({
      get: () => Effect.succeedSome({ workspaceRoot: "/repo" } as ProjectStore.ProjectRow),
    }),
    Layer.mock(ProviderRegistry)({ getProviders: Effect.succeed([provider]) }),
    FileSystem.layerNoop({
      readFile: (path) => Effect.succeed(new TextEncoder().encode(files.get(path) ?? "")),
    }),
    SqlitePersistenceMemory,
  );
  const context = yield* Layer.build(layer.pipe(Layer.provideMerge(dependencies)));
  const service = Context.get(context, SkillUsage);
  yield* service.start();

  // Each user turn reads its message exactly once; the worker runs events in
  // order, so once that read happens every earlier event has been handled.
  const send = (eventsToSend: ReadonlyArray<OrchestrationV2DomainEvent>) =>
    Effect.gen(function* () {
      yield* Queue.offerAll(events, eventsToSend);
      yield* Queue.take(messageReads);
      yield* service.drain;
    });
  return { service, send, files };
});

describe("SkillUsage", () => {
  it("keeps only skills the provider lists, crediting the user over the agent", () => {
    const used = skillsUsedInTurn({
      messageText: "/review then $deploy and not $20 or $unknown",
      agentSkillNames: ["deploy", "lint"],
      catalogNames: new Set(["review", "deploy"]),
    });
    assert.deepStrictEqual(
      [...used],
      [
        ["deploy", "user"],
        ["review", "user"],
        ["lint", "agent"],
      ],
    );
  });

  it.effect("averages each skill's turns with their subagents, per version", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const { service, send, files } = yield* makeHarness;
        const subagentEvent = {
          type: "subagent.updated",
          threadId,
          payload: claudeSubagent,
        } as unknown as OrchestrationV2DomainEvent;

        // The Claude subagent finishes first, and its event repeats.
        yield* send([
          subagentEvent,
          subagentEvent,
          turnEvent(threadId, first.turn, usage(10_000, 9_000, 300)),
        ]);
        // A subagent turn in its own thread lands after the user turn ended.
        yield* send([
          turnEvent(childThreadId, childTurn, usage(500, 0, 50)),
          turnEvent(threadId, interrupted.turn, usage(99_999, 0, 9_999)),
        ]);
        yield* TestClock.adjust("1 hour");
        files.set(reviewPath, "review v2");
        yield* send([turnEvent(threadId, third.turn, usage(2_000, 0, 200))]);

        const summary = yield* service.readSummary({ usageWindowsDays: [7, 30] });
        const review = summary.skills.find((skill) => skill.skillName === "review");
        const deploy = summary.skills.find((skill) => skill.skillName === "deploy");

        // Turn 1: 10,000 + 1,000 (Claude subagent) + 500 (own-thread subagent).
        assert.deepStrictEqual(
          deploy && {
            runs: deploy.runs,
            input: deploy.avgInputTokens,
            cached: deploy.avgCachedInputTokens,
            output: deploy.avgOutputTokens,
            versions: deploy.versions.map((version) => version.contentHash),
          },
          { runs: 1, input: 11_500, cached: 9_800, output: 450, versions: [sha256("deploy v1")] },
        );
        // The interrupted turn is left out; turn 3 ran the edited skill.
        assert.deepStrictEqual(
          review && {
            runs: review.runs,
            input: review.avgInputTokens,
            output: review.avgOutputTokens,
            versions: review.versions.map((version) => [version.contentHash, version.runs]),
          },
          {
            runs: 2,
            input: (11_500 + 2_000) / 2,
            output: (450 + 200) / 2,
            versions: [
              [sha256("review v2"), 1],
              [sha256("review v1"), 1],
            ],
          },
        );

        // Turn 1 ran 60s, 30s of it in `pnpm test`. The subagent in its own
        // thread ran `pnpm test` again; both calls group under one label.
        assert.deepStrictEqual(
          deploy && {
            timedRuns: deploy.timedRuns,
            total: deploy.avgTotalMs,
            model: deploy.avgModelMs,
            tools: deploy.avgToolMs,
            waiting: deploy.avgWaitingMs,
            slowestTools: deploy.slowestTools,
          },
          {
            timedRuns: 1,
            total: 60_000,
            model: 30_000,
            tools: 30_000,
            waiting: 0,
            slowestTools: [
              { kind: "command", label: "pnpm test", calls: 2, totalMs: 35_000, maxMs: 30_000 },
            ],
          },
        );
        // Turn 3 recorded no times, so review's time averages cover turn 1 only.
        assert.strictEqual(review?.timedRuns, 1);
        assert.strictEqual(review?.avgTotalMs, 60_000);

        // Recent uses count every turn the skill ran in, the interrupted one
        // too, per requested window; a use leaves a window while all-time
        // averages stay.
        const recentUses = (current: typeof summary) =>
          Object.fromEntries(
            current.skills.map((skill) => [
              skill.skillName,
              skill.recentUses.map((window) => [window.days, window.invocations]),
            ]),
          );
        assert.deepStrictEqual(recentUses(summary), {
          review: [
            [7, 3],
            [30, 3],
          ],
          deploy: [
            [7, 1],
            [30, 1],
          ],
        });
        yield* TestClock.adjust("8 days");
        const later = yield* service.readSummary({ usageWindowsDays: [7, 30] });
        assert.deepStrictEqual(recentUses(later), {
          review: [
            [7, 0],
            [30, 3],
          ],
          deploy: [
            [7, 0],
            [30, 1],
          ],
        });
        assert.strictEqual(later.skills.find((skill) => skill.skillName === "review")?.runs, 2);
      }),
    ),
  );
});
