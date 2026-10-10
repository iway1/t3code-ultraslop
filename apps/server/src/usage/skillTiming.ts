/**
 * Where a turn's time went: model work, tool calls, and waiting on the user.
 *
 * Tool calls can overlap, so each call keeps its own duration for "which tool
 * is slow" while the turn's split uses merged spans. Time a call spent behind
 * an approval or question is the user's, not the tool's.
 *
 * @module usage/skillTiming
 */
import type { OrchestrationV2TurnItem, SkillToolKind } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

interface Interval {
  readonly start: number;
  readonly end: number;
}

export interface ToolGroup {
  readonly kind: SkillToolKind;
  readonly label: string;
  readonly calls: number;
  readonly totalMs: number;
  readonly maxMs: number;
}

export interface TurnTiming {
  readonly wallMs: number;
  readonly modelMs: number;
  readonly toolMs: number;
  readonly waitingMs: number;
}

function merge(intervals: ReadonlyArray<Interval>): Array<Interval> {
  const merged: Array<Interval> = [];
  for (const interval of intervals.toSorted((left, right) => left.start - right.start)) {
    const last = merged.at(-1);
    if (last !== undefined && interval.start <= last.end) {
      merged[merged.length - 1] = { start: last.start, end: Math.max(last.end, interval.end) };
    } else if (interval.end > interval.start) {
      merged.push(interval);
    }
  }
  return merged;
}

const total = (merged: ReadonlyArray<Interval>) =>
  merged.reduce((sum, interval) => sum + interval.end - interval.start, 0);

function overlap(interval: Interval, merged: ReadonlyArray<Interval>): number {
  return merged.reduce(
    (sum, other) =>
      sum + Math.max(0, Math.min(interval.end, other.end) - Math.max(interval.start, other.start)),
    0,
  );
}

/** Groups shell commands by what they run: `pnpm test`, not `pnpm test --filter web`. */
export function commandLabel(input: string): string {
  let command = input.trim().split("\n")[0] ?? "";
  // Codex wraps commands in a login shell: `/bin/zsh -lc 'pnpm test'`.
  const wrapped = /^(?:\S*\/)?(?:ba|z)?sh\s+-l?c\s+(['"])(.*)\1$/u.exec(command);
  if (wrapped) command = wrapped[2] ?? command;
  command = command.replace(/^cd\s+\S+\s*&&\s*/u, "");
  const words = command.split(/\s+/u).filter((word) => !/^[A-Z_][A-Z0-9_]*=/u.test(word));
  const [program = "", subcommand] = words;
  const name = program.split("/").at(-1) ?? program;
  return subcommand !== undefined && /^[a-z][\w:-]*$/u.test(subcommand)
    ? `${name} ${subcommand}`
    : name || "command";
}

function toolOf(item: OrchestrationV2TurnItem): Pick<ToolGroup, "kind" | "label"> | null {
  switch (item.type) {
    case "command_execution":
      return { kind: "command", label: commandLabel(item.input) };
    case "file_change":
      return { kind: "edit", label: "File edits" };
    case "file_search":
      return { kind: "search", label: "File search" };
    case "web_search":
      return { kind: "web", label: "Web search" };
    case "dynamic_tool":
      return { kind: "tool", label: item.toolName ?? (item.title?.trim() || "Tool") };
    case "subagent":
      return { kind: "subagent", label: item.title?.trim() || "Subagent" };
    default:
      return null;
  }
}

const isWaitingOnUser = (item: OrchestrationV2TurnItem) =>
  item.type === "approval_request" || item.type === "user_input_request";

function spanOf(item: OrchestrationV2TurnItem, end: number, clip?: Interval): Interval | null {
  if (item.startedAt === null) return null;
  const start = DateTime.toEpochMillis(item.startedAt);
  const stop = item.completedAt === null ? end : DateTime.toEpochMillis(item.completedAt);
  const span = clip
    ? { start: Math.max(start, clip.start), end: Math.min(stop, clip.end) }
    : { start, end: stop };
  return span.end > span.start ? span : null;
}

/**
 * Per-tool time for a set of items, less any time spent waiting on the user.
 * Unfinished calls run to `end`, the end of the turn that ran them.
 */
export function toolGroupsOf(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  end: number,
  clip?: Interval,
): Array<ToolGroup> {
  const waiting = merge(
    items.flatMap((item) => (isWaitingOnUser(item) ? (spanOf(item, end, clip) ?? []) : [])),
  );
  const groups = new Map<string, ToolGroup>();
  for (const item of items) {
    const tool = toolOf(item);
    const span = tool === null ? null : spanOf(item, end, clip);
    if (tool === null || span === null) continue;
    const ms = span.end - span.start - overlap(span, waiting);
    const key = `${tool.kind}\u0000${tool.label}`;
    const group = groups.get(key);
    groups.set(key, {
      ...tool,
      calls: (group?.calls ?? 0) + 1,
      totalMs: (group?.totalMs ?? 0) + ms,
      maxMs: Math.max(group?.maxMs ?? 0, ms),
    });
  }
  return [...groups.values()];
}

/** How a turn's wall time splits between the model, its tools, and the user. */
export function turnTimingOf(
  items: ReadonlyArray<OrchestrationV2TurnItem>,
  turn: Interval,
): TurnTiming {
  const spans = (keep: (item: OrchestrationV2TurnItem) => boolean) =>
    items.flatMap((item) => (keep(item) ? (spanOf(item, turn.end, turn) ?? []) : []));
  const waiting = merge(spans(isWaitingOnUser));
  const toolOrWaiting = merge([...spans((item) => toolOf(item) !== null), ...waiting]);
  const wallMs = Math.max(0, turn.end - turn.start);
  const waitingMs = total(waiting);
  const toolMs = total(toolOrWaiting) - waitingMs;
  return { wallMs, waitingMs, toolMs, modelMs: Math.max(0, wallMs - toolMs - waitingMs) };
}
