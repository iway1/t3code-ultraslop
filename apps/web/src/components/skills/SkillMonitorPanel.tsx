import {
  estimateSkillAmbientTokens,
  formatProviderSkillDisplayName,
  resolveProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import {
  type ProjectId,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ScopedThreadRef,
  type ServerProvider,
  SKILL_RECENT_SESSION_DAYS,
  type SkillInventory,
  type SkillInventorySkill,
  type SkillMonitorSettings,
  type SkillQuotaUsage,
  type SkillUsage,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatPercent, formatTokens } from "@t3tools/shared/usageFormat";
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BoxIcon,
  ChartColumnIcon,
  InfoIcon,
  SettingsIcon,
  XIcon,
} from "lucide-react";
import { lazy, type ReactElement, type ReactNode, Suspense, useMemo, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useProjects } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { SkillSourceBadge } from "../chat/ComposerCommandMenu";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { moveColumn, orderColumns } from "./columnOrder";
import type { ChartSkill } from "./SkillUsageChartDialog";
import { chartMetricForColumn } from "./skillUsageChart";

/** Marks a column-header drag, so files and text dropped on the table are ignored. */
const COLUMN_DRAG_TYPE = "application/x-t3-skill-monitor-column";

// Loaded on first open so the chat view does not carry settings-page code.
const SkillMonitorSettingsDialog = lazy(() =>
  import("../settings/SkillMonitorSettings").then((module) => ({
    default: module.SkillMonitorSettingsDialog,
  })),
);
// Loaded on first open, as on a skill's file view.
const SkillUsageChartDialog = lazy(() =>
  import("./SkillUsageChartDialog").then((module) => ({
    default: module.SkillUsageChartDialog,
  })),
);

/** Harnesses that get their own on/off column, in column order. */
const HARNESSES = [
  { driver: "claudeAgent", name: "Claude Code" },
  { driver: "codex", name: "Codex" },
] as const;

export interface SkillRow {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** The thread provider's copy when it has one, for the path and source. */
  readonly skill: SkillInventorySkill;
  /** Each column provider's copy of the skill, by instance. */
  readonly byInstance: ReadonlyMap<ProviderInstanceId, SkillInventorySkill>;
  /** Under the thread's provider; null when that provider does not list it. */
  readonly ambientTokens: number | null;
  readonly usage: SkillUsage | undefined;
}

interface Column {
  readonly key: string;
  readonly header: string;
  readonly hint?: string;
  /** Sort value; null sorts last. */
  readonly value: (row: SkillRow) => number | null;
  readonly render: (row: SkillRow) => ReactNode;
}

type Sort = { readonly key: string; readonly direction: "asc" | "desc" } | null;

const timed = (usage: SkillUsage | undefined) =>
  usage !== undefined && usage.timedRuns > 0 ? usage : undefined;
const completed = (usage: SkillUsage | undefined) =>
  usage !== undefined && usage.runs > 0 ? usage : undefined;

/**
 * The metric columns the Skill Monitor settings turn on, in display order.
 * Usage-limit shares are the thread provider's, as other providers' runs
 * count against other plans.
 */
export function metricColumns(
  display: SkillMonitorSettings,
  driver: ProviderDriverKind | null,
): ReadonlyArray<Column> {
  const tokens = (
    key: string,
    header: string,
    hint: string,
    pick: (usage: SkillUsage) => number,
  ): Column => ({
    key,
    header,
    hint,
    value: (row) => {
      const usage = completed(row.usage);
      return usage === undefined ? null : pick(usage);
    },
    render: (row) => {
      const usage = completed(row.usage);
      return usage === undefined ? "—" : formatTokens(pick(usage));
    },
  });
  const limit = (
    key: string,
    header: string,
    hint: string,
    pick: (quota: SkillQuotaUsage) => number | null,
  ): Column => {
    const value = (row: SkillRow) => {
      const quota = row.usage?.quota.find((entry) => entry.driver === driver);
      return quota === undefined ? null : pick(quota);
    };
    return {
      key,
      header,
      hint,
      value,
      render: (row) => {
        const percent = value(row);
        return percent === null ? "—" : formatPercent(percent / 100, percent >= 1 ? 1 : 2);
      },
    };
  };
  const time = (
    key: string,
    header: string,
    hint: string,
    pick: (usage: SkillUsage) => number,
  ): Column => ({
    key,
    header,
    hint,
    value: (row) => {
      const usage = timed(row.usage);
      return usage === undefined ? null : pick(usage);
    },
    render: (row) => {
      const usage = timed(row.usage);
      return usage === undefined ? "—" : formatDuration(pick(usage));
    },
  });
  return [
    ...(display.showAmbientTokens
      ? [
          {
            key: "ambient",
            header: "Ambient",
            hint: "Estimated tokens the skill adds to every new session of this thread's provider",
            value: (row: SkillRow) => row.ambientTokens,
            render: (row: SkillRow) =>
              row.ambientTokens === null ? "—" : formatTokens(row.ambientTokens),
          },
        ]
      : []),
    ...display.usageWindowsDays.map((days): Column => ({
      key: `uses:${days}`,
      header: `Uses (${days === 1 ? "1 day" : `${days} days`})`,
      hint: `Number of turns the skill ran in over the last ${days === 1 ? "day" : `${days} days`}, finished or not`,
      value: (row) => usesIn(row.usage, days),
      render: (row) => String(usesIn(row.usage, days)),
    })),
    ...(display.showAverageCachedTokens
      ? [
          tokens(
            "cached",
            "Cached",
            "Cached input tokens, averaged per completed run, subagents included",
            (usage) => usage.avgCachedInputTokens,
          ),
        ]
      : []),
    ...(display.showAverageInputTokens
      ? [
          tokens(
            "input",
            "Input",
            "Input tokens, cached ones included, averaged per completed run, subagents included",
            (usage) => usage.avgInputTokens,
          ),
        ]
      : []),
    ...(display.showAverageOutputTokens
      ? [
          tokens(
            "output",
            "Output",
            "Output tokens, reasoning included, averaged per completed run, subagents included",
            (usage) => usage.avgOutputTokens,
          ),
        ]
      : []),
    ...(display.showAverageSessionLimit
      ? [
          limit(
            "session-limit",
            "5-hour limit",
            "Estimated percentage of your 5-hour usage limit, averaged per completed run, subagents included",
            (quota) => (quota.sessionRuns > 0 ? quota.avgSessionPercent : null),
          ),
        ]
      : []),
    ...(display.showAverageWeeklyLimit
      ? [
          limit(
            "weekly-limit",
            "Weekly limit",
            "Estimated percentage of your weekly usage limit, averaged per completed run, subagents included",
            (quota) => (quota.weeklyRuns > 0 ? quota.avgWeeklyPercent : null),
          ),
        ]
      : []),
    ...(display.showRecentSessionLimit
      ? [
          limit(
            "session-limit-recent",
            `5-hour limit (${SKILL_RECENT_SESSION_DAYS} days)`,
            `Estimated percentage of your 5-hour usage limit the skill used over the last ${SKILL_RECENT_SESSION_DAYS} days, summed across every run, finished or not`,
            (quota) => (quota.recentSessionRuns > 0 ? quota.recentSessionPercent : null),
          ),
        ]
      : []),
    ...(display.showAverageTotalTime
      ? [
          time(
            "total",
            "Total time",
            "Time from start to finish, averaged per completed run",
            (usage) => usage.avgTotalMs,
          ),
        ]
      : []),
    ...(display.showAverageModelTime
      ? [
          time(
            "model",
            "Model",
            "Time the model spent working, averaged per completed run",
            (usage) => usage.avgModelMs,
          ),
        ]
      : []),
    ...(display.showAverageToolTime
      ? [
          time(
            "tools",
            "Tools",
            "Time spent in tool calls, averaged per completed run",
            (usage) => usage.avgToolMs,
          ),
        ]
      : []),
    ...(display.showAverageWaitingTime
      ? [
          time(
            "waiting",
            "Waiting",
            "Time spent waiting on you for approvals and answers, averaged per completed run",
            (usage) => usage.avgWaitingMs,
          ),
        ]
      : []),
    ...(display.showSlowestTool
      ? [
          {
            key: "slowest",
            header: "Slowest tool",
            hint: "The tool that took the most time, averaged per completed run",
            value: (row: SkillRow) => slowestPerRun(row.usage),
            render: (row: SkillRow) => <SlowestTool usage={timed(row.usage)} />,
          },
        ]
      : []),
    ...display.toolColumns.map((tool): Column => {
      const timedTool = (row: SkillRow) => {
        const usage = timed(row.usage);
        const used = usage?.tools.find(
          (entry) => entry.kind === tool.kind && entry.label === tool.label,
        );
        return usage === undefined || used === undefined ? undefined : { usage, used };
      };
      return {
        key: `tool:${tool.kind}:${tool.label}`,
        header: tool.label,
        hint: `Time spent in ${tool.label}, averaged per completed run, subagents included. Runs that never called it count as zero`,
        value: (row) => {
          const found = timedTool(row);
          return found === undefined ? null : found.used.totalMs / found.usage.timedRuns;
        },
        render: (row) => {
          const found = timedTool(row);
          if (found === undefined) return "—";
          const { usage, used } = found;
          return (
            <InstantTooltip
              trigger={<span />}
              content={`${used.calls} ${used.calls === 1 ? "call" : "calls"} in ${usage.timedRuns} ${
                usage.timedRuns === 1 ? "run" : "runs"
              } · longest ${formatDuration(used.maxMs)}`}
            >
              {formatDuration(used.totalMs / usage.timedRuns)}
            </InstantTooltip>
          );
        },
      };
    }),
  ];
}

function usesIn(usage: SkillUsage | undefined, days: number): number {
  return usage?.recentUses.find((window) => window.days === days)?.invocations ?? 0;
}

function slowestPerRun(usage: SkillUsage | undefined): number | null {
  const timedUsage = timed(usage);
  const slowest = timedUsage?.slowestTools[0];
  return timedUsage === undefined || slowest === undefined
    ? null
    : slowest.totalMs / timedUsage.timedRuns;
}

function sortRows(
  rows: ReadonlyArray<SkillRow>,
  columns: ReadonlyArray<Pick<Column, "key" | "value">>,
  sort: Sort,
): ReadonlyArray<SkillRow> {
  if (sort === null) return rows;
  const direction = sort.direction === "asc" ? 1 : -1;
  if (sort.key === "skill") {
    return rows.toSorted((left, right) => left.label.localeCompare(right.label) * direction);
  }
  const column = columns.find((candidate) => candidate.key === sort.key);
  if (column === undefined) return rows;
  return rows.toSorted((left, right) => {
    const leftValue = column.value(left);
    const rightValue = column.value(right);
    if (leftValue === rightValue) return 0;
    if (leftValue === null) return 1;
    if (rightValue === null) return -1;
    return (leftValue - rightValue) * direction;
  });
}

/** The project filter's value for every project. */
const ALL_PROJECTS = "all";

/**
 * What hiding a skill does, for the confirmation: every provider that lists it
 * switches it off, except where it ships with a plugin and switches with that.
 */
function describeHide(
  skillName: string,
  label: string,
  inventory: SkillInventory | null,
  providers: ReadonlyArray<ServerProvider>,
): string {
  const nameOf = (instanceId: ProviderInstanceId) => {
    const provider = providers.find((candidate) => candidate.instanceId === instanceId);
    const harness = HARNESSES.find((candidate) => candidate.driver === provider?.driver);
    return provider?.displayName ?? harness?.name ?? instanceId;
  };
  const copies = (inventory?.providers ?? []).flatMap((listing) => {
    const skill = listing.skills.find((candidate) => candidate.name === skillName);
    return skill === undefined ? [] : [{ name: nameOf(listing.instanceId), plugin: skill.plugin }];
  });
  const listNames = (names: ReadonlyArray<string>) =>
    names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
  const switched = copies.filter((copy) => copy.plugin === undefined).map((copy) => copy.name);
  const plugged = copies.filter((copy) => copy.plugin !== undefined);
  return [
    switched.length > 0
      ? `This turns ${label} off in ${listNames(switched)} for every project on this machine, so agents stop loading it, and removes it from the Skill Monitor.`
      : `This removes ${label} from the Skill Monitor.`,
    plugged.length > 0
      ? `It stays on in ${listNames(plugged.map((copy) => copy.name))}, where it turns on and off with the ${plugged[0]!.plugin} plugin.`
      : "",
    "To bring it back, use Settings → Skill Monitor → Hidden skills, which also turns it on again.",
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
}

const pendingKey = (instanceId: ProviderInstanceId, skillName: string) =>
  `${instanceId}\u0000${skillName}`;

/**
 * Skill Monitor surface: a table of every skill the installed Claude Code and
 * Codex can load in any project, with an on/off switch per harness that
 * applies to the whole machine, what each skill adds to every session of the
 * thread's provider, and what its runs cost. A filter narrows it to one
 * project. Clicking a name opens its SKILL.md.
 */
export function SkillMonitorPanel(props: {
  threadRef: ScopedThreadRef;
  provider: ServerProvider | null;
  providers: ReadonlyArray<ServerProvider>;
  cwd: string | null;
}) {
  const { threadRef, provider, providers, cwd } = props;
  const display = useClientSettings((settings) => settings.skillMonitor);
  const usageSummary = useEnvironmentQuery(
    serverEnvironment.skillUsageSummary({
      environmentId: threadRef.environmentId,
      input: { usageWindowsDays: display.usageWindowsDays, tools: display.toolColumns },
    }),
  ).data;
  const queried = useEnvironmentQuery(
    serverEnvironment.skillInventory({ environmentId: threadRef.environmentId, input: {} }),
  ).data;
  const setSkillEnabled = useAtomCommand(serverEnvironment.setSkillEnabled, "skill toggle");
  const setSkillHidden = useAtomCommand(serverEnvironment.setSkillHidden, "hide skill");
  // The row the confirmation is about; kept after closing so it can animate out.
  const [hideTarget, setHideTarget] = useState<SkillRow | null>(null);
  const [hideOpen, setHideOpen] = useState(false);
  const [hidingName, setHidingName] = useState<string | null>(null);
  // The skill the chart compares, and the metric it opens on; kept after
  // closing so the dialog can animate out.
  const [chart, setChart] = useState<{ row: SkillRow; metricKey: string } | null>(null);
  const [chartOpen, setChartOpen] = useState(false);
  // The switch shows where it is headed until the server answers.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  // The server answers with the whole inventory, which stands until the query
  // fetches a newer one, so the switch never flashes its old position.
  const [answered, setAnswered] = useState<{
    readonly queried: SkillInventory | null;
    readonly inventory: SkillInventory | null;
  }>({ queried, inventory: null });
  if (answered.queried !== queried) setAnswered({ queried, inventory: null });
  const inventory = answered.inventory ?? queried;
  const allProjects = useProjects();
  const projects = useMemo(
    () =>
      allProjects
        .filter((project) => project.environmentId === threadRef.environmentId)
        .toSorted((left, right) => left.title.localeCompare(right.title)),
    [allProjects, threadRef.environmentId],
  );
  // Null shows every project.
  const [projectFilter, setProjectFilter] = useState<ProjectId | null>(null);
  const [sort, setSort] = useState<Sort>(null);
  // The metric column being dragged, and the header it would land on.
  const [drag, setDrag] = useState<{ from: string; over: string | null } | null>(null);
  const updateSettings = useUpdateClientSettings();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Stays mounted after the first open so closing can animate.
  const [settingsMounted, setSettingsMounted] = useState(false);

  // One column per installed harness, preferring the thread's own instance.
  const harnesses = useMemo(
    () =>
      HARNESSES.flatMap((harness) => {
        const installed = providers.filter(
          (candidate) =>
            candidate.driver === harness.driver && candidate.installed && candidate.enabled,
        );
        const chosen =
          installed.find((candidate) => candidate.instanceId === provider?.instanceId) ??
          installed[0];
        return chosen === undefined ? [] : [{ ...harness, provider: chosen }];
      }),
    [provider, providers],
  );
  const sources = useMemo(() => {
    const all = [...(provider === null ? [] : [provider]), ...harnesses.map((h) => h.provider)];
    return all.filter(
      (candidate, index) =>
        all.findIndex((other) => other.instanceId === candidate.instanceId) === index,
    );
  }, [provider, harnesses]);

  const rows = useMemo(() => {
    const usageBySkill = new Map(usageSummary?.skills.map((usage) => [usage.skillName, usage]));
    const sourceIds = new Set(sources.map((source) => source.instanceId));
    const hidden = new Set(inventory?.hiddenSkills);
    const byName = new Map<
      string,
      { first: SkillInventorySkill; byInstance: Map<ProviderInstanceId, SkillInventorySkill> }
    >();
    for (const listing of inventory?.providers ?? []) {
      if (!sourceIds.has(listing.instanceId)) continue;
      for (const skill of listing.skills) {
        if (hidden.has(skill.name)) continue;
        if (projectFilter !== null && skill.projectIds?.includes(projectFilter) === false) {
          continue;
        }
        const entry = byName.get(skill.name) ?? { first: skill, byInstance: new Map() };
        entry.byInstance.set(listing.instanceId, skill);
        byName.set(skill.name, entry);
      }
    }
    return Array.from(byName, ([name, { first, byInstance }]): SkillRow => {
      const own = provider === null ? undefined : byInstance.get(provider.instanceId);
      const skill = own ?? first;
      return {
        name,
        label: formatProviderSkillDisplayName(skill),
        description: skill.shortDescription ?? skill.description ?? "",
        skill,
        byInstance,
        ambientTokens:
          own === undefined || provider === null
            ? null
            : estimateSkillAmbientTokens(own, provider.driver),
        usage: usageBySkill.get(name),
      };
    });
  }, [inventory, projectFilter, provider, sources, usageSummary]);
  // The skills the chart can switch to: the table's.
  const chartSkills = useMemo(
    () =>
      rows.map((row): ChartSkill => ({
        name: row.name,
        label: row.label,
        kind: resolveProviderSkillSourceKind(row.skill),
      })),
    [rows],
  );
  const driver = provider?.driver ?? null;
  const columns = useMemo(
    () => orderColumns(metricColumns(display, driver), display.columnOrder),
    [display, driver],
  );
  // A harness column sorts skills on there first, then off, then missing there.
  const harnessSorts = useMemo(
    () =>
      harnesses.map((harness) => ({
        key: `harness:${harness.provider.instanceId}`,
        value: (row: SkillRow) => {
          const copy = row.byInstance.get(harness.provider.instanceId);
          return copy === undefined ? 0 : copy.enabled ? 2 : 1;
        },
      })),
    [harnesses],
  );
  const sortedRows = useMemo(
    () => sortRows(rows, [...harnessSorts, ...columns], sort),
    [rows, harnessSorts, columns, sort],
  );
  const ambientTotal = rows.reduce((total, row) => total + (row.ambientTokens ?? 0), 0);

  const toggle = (source: ServerProvider, skillName: string, enabled: boolean) => {
    if (cwd === null) return;
    const key = pendingKey(source.instanceId, skillName);
    setPending((current) => new Map(current).set(key, enabled));
    void setSkillEnabled({
      environmentId: threadRef.environmentId,
      input: { instanceId: source.instanceId, cwd, skillName, enabled },
    }).then((result) => {
      if (result._tag === "Success") {
        setAnswered((current) => ({ ...current, inventory: result.value }));
      }
      setPending((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      });
    });
  };
  const hide = (row: SkillRow) => {
    setHideOpen(false);
    setHidingName(row.name);
    void setSkillHidden({
      environmentId: threadRef.environmentId,
      input: { skillName: row.name, hidden: true },
    }).then((result) => {
      if (result._tag === "Success") {
        setAnswered((current) => ({ ...current, inventory: result.value }));
      }
      setHidingName(null);
    });
  };
  const cycleSort = (key: string) => {
    // Names start A–Z, numbers largest first; the next click reverses, the third clears.
    const first = key === "skill" ? "asc" : "desc";
    setSort((current) =>
      current?.key !== key
        ? { key, direction: first }
        : current.direction === first
          ? { key, direction: first === "asc" ? "desc" : "asc" }
          : null,
    );
  };
  const dropColumn = (to: string) => {
    if (drag !== null && drag.from !== to) {
      const shownKeys = columns.map((column) => column.key);
      updateSettings({
        skillMonitor: {
          ...display,
          columnOrder: moveColumn(display.columnOrder, shownKeys, drag.from, to),
        },
      });
    }
    setDrag(null);
  };
  // The column a drop would land beside, and on which edge, drawn down every cell.
  const dropLine =
    drag === null || drag.over === null || drag.over === drag.from
      ? null
      : {
          key: drag.over,
          side:
            columns.findIndex((column) => column.key === drag.over) >
            columns.findIndex((column) => column.key === drag.from)
              ? ("right" as const)
              : ("left" as const),
        };
  const openSettings = () => {
    setSettingsMounted(true);
    setSettingsOpen(true);
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-border/60 py-1 pr-1.5 pl-3">
        <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground text-xs">
          <span className="min-w-0 truncate tabular-nums">
            {rows.length === 1 ? "1 skill" : `${rows.length} skills`} · ~
            {formatTokens(ambientTotal)} ambient tokens per new session
          </span>
          <InstantTooltip
            trigger={
              <button
                type="button"
                aria-label="About ambient tokens"
                className="inline-flex shrink-0 text-muted-foreground hover:text-foreground"
              />
            }
            content={
              <>
                Estimated for this thread&apos;s provider from each skill&apos;s name and
                description (and its path for Codex), at about four characters per token. The
                provider sends these with every new session so the model knows the skills exist;
                after the first call they are usually cached. Skills that are off or hidden from the
                agent add nothing.
              </>
            }
          >
            <InfoIcon className="size-3" />
          </InstantTooltip>
        </span>
        <div className="flex shrink-0 items-center gap-1">
          <div className="flex w-40">
            <Select
              value={projectFilter ?? ALL_PROJECTS}
              onValueChange={(value) =>
                setProjectFilter(
                  value === null || value === ALL_PROJECTS
                    ? null
                    : (projects.find((project) => project.id === value)?.id ?? null),
                )
              }
            >
              <SelectTrigger size="xs" aria-label="Show skills for a project">
                <SelectValue>
                  {(value: string | null) =>
                    projects.find((project) => project.id === value)?.title ?? "All projects"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem value={ALL_PROJECTS}>All projects</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.title}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label="Skill Monitor settings"
                  onClick={openSettings}
                />
              }
            >
              <SettingsIcon />
            </TooltipTrigger>
            <TooltipPopup>Skill Monitor settings</TooltipPopup>
          </Tooltip>
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <BoxIcon aria-hidden className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">No skills found</p>
          <p className="max-w-60 text-xs text-muted-foreground">
            Skills Claude Code and Codex can load in any project show up here.
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <Table variant="grid">
            <TableHeader>
              <TableRow>
                <TableHead>
                  <span className="sr-only">Hide</span>
                </TableHead>
                {harnesses.map((harness) => (
                  <TableHead key={harness.driver}>
                    <span className="flex justify-center">
                      <SortButton
                        sort={sort}
                        sortKey={`harness:${harness.provider.instanceId}`}
                        onSort={cycleSort}
                        hint={`On in ${harness.name}`}
                      >
                        <ProviderInstanceIcon
                          driverKind={harness.provider.driver}
                          displayName={harness.provider.displayName ?? harness.name}
                          iconClassName="size-3.5"
                        />
                        <span className="sr-only">{harness.name}</span>
                      </SortButton>
                    </span>
                  </TableHead>
                ))}
                <TableHead>
                  <SortButton sort={sort} sortKey="skill" onSort={cycleSort}>
                    Skill
                  </SortButton>
                </TableHead>
                <TableHead>Type</TableHead>
                {columns.map((column) => (
                  <TableHead
                    key={column.key}
                    className="relative"
                    draggable
                    onDragStart={(event) => {
                      // Firefox only starts a drag that carries data.
                      event.dataTransfer.setData(COLUMN_DRAG_TYPE, column.key);
                      event.dataTransfer.effectAllowed = "move";
                      setDrag({ from: column.key, over: null });
                    }}
                    onDragOver={(event) => {
                      if (drag === null) return;
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      if (drag.over !== column.key) setDrag({ ...drag, over: column.key });
                    }}
                    onDragLeave={(event) => {
                      // Moving onto the header's own button is not leaving it.
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      setDrag((current) =>
                        current?.over === column.key ? { ...current, over: null } : current,
                      );
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      dropColumn(column.key);
                    }}
                    onDragEnd={() => setDrag(null)}
                  >
                    <SortButton
                      sort={sort}
                      sortKey={column.key}
                      onSort={cycleSort}
                      {...(column.hint === undefined ? {} : { hint: column.hint })}
                    >
                      {column.header}
                    </SortButton>
                    {dropLine?.key === column.key ? <DropLine side={dropLine.side} /> : null}
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.map((row) => {
                const isOn = (source: ServerProvider) => {
                  const key = pendingKey(source.instanceId, row.name);
                  return (
                    pending.get(key) ?? row.byInstance.get(source.instanceId)?.enabled ?? false
                  );
                };
                const dim = sources.some(isOn) ? undefined : "opacity-60";
                return (
                  <TableRow key={row.name}>
                    <TableCell>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              size="icon-xs"
                              variant="ghost"
                              aria-label={`Hide ${row.label}`}
                              disabled={hidingName === row.name}
                              onClick={() => {
                                setHideTarget(row);
                                setHideOpen(true);
                              }}
                            />
                          }
                        >
                          <XIcon />
                        </TooltipTrigger>
                        <TooltipPopup>Hide</TooltipPopup>
                      </Tooltip>
                    </TableCell>
                    {harnesses.map((harness) => {
                      const copy = row.byInstance.get(harness.provider.instanceId);
                      const on = isOn(harness.provider);
                      const toggleSwitch =
                        copy === undefined ? null : (
                          <Switch
                            size="sm"
                            checked={on}
                            disabled={
                              copy.plugin !== undefined ||
                              harness.provider.skillToggle !== true ||
                              cwd === null ||
                              pending.has(pendingKey(harness.provider.instanceId, row.name))
                            }
                            onCheckedChange={(checked) =>
                              toggle(harness.provider, row.name, checked)
                            }
                            aria-label={`${on ? "Turn off" : "Turn on"} ${row.label} in ${harness.name}`}
                          />
                        );
                      return (
                        <TableCell key={harness.driver}>
                          {toggleSwitch === null ? (
                            <span className="text-muted-foreground">—</span>
                          ) : copy?.plugin === undefined ? (
                            toggleSwitch
                          ) : (
                            // A disabled switch takes no pointer events, so the
                            // tooltip hangs on a wrapper.
                            <InstantTooltip
                              trigger={<span className="inline-flex" />}
                              content={`Turns on and off with the ${copy.plugin} plugin`}
                            >
                              {toggleSwitch}
                            </InstantTooltip>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell>
                      <span className="flex max-w-64 min-w-32">
                        <InstantTooltip
                          disabled={row.description === ""}
                          trigger={
                            row.skill.path === undefined ? (
                              <span className={`min-w-0 truncate font-medium ${dim ?? ""}`} />
                            ) : (
                              <button
                                type="button"
                                className={`min-w-0 truncate text-left font-medium hover:underline ${dim ?? ""}`}
                                onClick={() => {
                                  if (row.skill.path !== undefined) {
                                    useRightPanelStore
                                      .getState()
                                      .openFile(threadRef, row.skill.path);
                                  }
                                }}
                              />
                            )
                          }
                          content={row.description}
                        >
                          {row.label}
                        </InstantTooltip>
                        {row.usage === undefined ? null : (
                          <span className="ml-auto shrink-0 pl-1">
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <Button
                                    size="icon-xs"
                                    variant="ghost"
                                    aria-label={`Compare ${row.label} across versions and models`}
                                    onClick={() => {
                                      // Open on the sorted column's metric, else the first chartable one.
                                      const metric =
                                        chartMetricForColumn(sort?.key ?? "") ??
                                        columns
                                          .map((column) => chartMetricForColumn(column.key))
                                          .find((candidate) => candidate !== undefined);
                                      setChart({ row, metricKey: metric?.key ?? "runs" });
                                      setChartOpen(true);
                                    }}
                                  />
                                }
                              >
                                <ChartColumnIcon />
                              </TooltipTrigger>
                              <TooltipPopup>Compare versions and models</TooltipPopup>
                            </Tooltip>
                          </span>
                        )}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={dim}>
                        <SkillSourceBadge kind={resolveProviderSkillSourceKind(row.skill)} />
                      </span>
                    </TableCell>
                    {columns.map((column) => (
                      <TableCell key={column.key} className="relative">
                        <span className={`tabular-nums ${dim ?? ""}`}>{column.render(row)}</span>
                        {dropLine?.key === column.key ? <DropLine side={dropLine.side} /> : null}
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
      {chart === null ? null : (
        <Suspense fallback={null}>
          <SkillUsageChartDialog
            // A new skill starts on its own metric and models.
            key={chart.row.name}
            environmentId={threadRef.environmentId}
            skillName={chart.row.name}
            skills={chartSkills}
            initialMetricKey={chart.metricKey}
            open={chartOpen}
            onOpenChange={setChartOpen}
          />
        </Suspense>
      )}
      <AlertDialog open={hideOpen} onOpenChange={setHideOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Hide {hideTarget?.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              {hideTarget === null
                ? null
                : describeHide(hideTarget.name, hideTarget.label, inventory, providers)}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="default"
              onClick={() => {
                if (hideTarget !== null) hide(hideTarget);
              }}
            >
              Hide skill
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
      {settingsMounted ? (
        <Suspense fallback={null}>
          <SkillMonitorSettingsDialog
            environmentId={threadRef.environmentId}
            open={settingsOpen}
            onOpenChange={setSettingsOpen}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

/**
 * One cell's share of the line where a dragged column would land. It reaches
 * a pixel up over the row border so the line does not break between rows.
 */
function DropLine(props: { side: "left" | "right" }) {
  return (
    <span
      aria-hidden
      className={`pointer-events-none absolute -top-px bottom-0 w-0.5 bg-primary ${
        props.side === "right" ? "right-0" : "left-0"
      }`}
    />
  );
}

/** A tooltip that opens the moment its trigger is hovered. */
export function InstantTooltip(props: {
  trigger: ReactElement;
  content: ReactNode;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <Tooltip {...(props.disabled ? { disabled: true } : {})}>
      <TooltipTrigger delay={0} closeDelay={0} render={props.trigger}>
        {props.children}
      </TooltipTrigger>
      <TooltipPopup className="max-w-80 whitespace-normal">{props.content}</TooltipPopup>
    </Tooltip>
  );
}

/** A column header that sorts the table by that column; its hint shows on hover. */
function SortButton(props: {
  sort: Sort;
  sortKey: string;
  hint?: string;
  onSort: (key: string) => void;
  children: ReactNode;
}) {
  const direction = props.sort?.key === props.sortKey ? props.sort.direction : null;
  return (
    <InstantTooltip
      disabled={props.hint === undefined}
      trigger={
        <button
          type="button"
          className="inline-flex items-center gap-1 font-medium hover:text-foreground"
          onClick={() => props.onSort(props.sortKey)}
        />
      }
      content={props.hint}
    >
      {props.children}
      {direction === "asc" ? <ArrowUpIcon className="size-3" /> : null}
      {direction === "desc" ? <ArrowDownIcon className="size-3" /> : null}
    </InstantTooltip>
  );
}

/** The slowest tool's time per run; hovering it lists the top tools. */
function SlowestTool(props: { usage: SkillUsage | undefined }) {
  const { usage } = props;
  const slowest = usage?.slowestTools[0];
  if (usage === undefined || slowest === undefined) return "—";
  return (
    <InstantTooltip
      trigger={<span />}
      content={
        <ul className="space-y-0.5">
          {usage.slowestTools.map((tool) => (
            <li key={`${tool.kind}:${tool.label}`} className="tabular-nums">
              {tool.label}: {formatDuration(tool.totalMs / usage.timedRuns)} per run · {tool.calls}{" "}
              {tool.calls === 1 ? "call" : "calls"} · longest {formatDuration(tool.maxMs)}
            </li>
          ))}
        </ul>
      }
    >
      {slowest.label} {formatDuration(slowest.totalMs / usage.timedRuns)}
    </InstantTooltip>
  );
}
