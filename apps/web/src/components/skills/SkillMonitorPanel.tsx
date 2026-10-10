import {
  dedupeProviderSkillsByName,
  estimateSkillAmbientTokens,
  formatProviderSkillDisplayName,
  resolveProviderSkillSourceKind,
  resolveProviderSkillsForCwd,
} from "@t3tools/client-runtime/providerSkills";
import type {
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
  ServerProviderSkill,
  SkillMonitorSettings,
  SkillUsage,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatTokens } from "@t3tools/shared/usageFormat";
import { ArrowDownIcon, ArrowUpIcon, BoxIcon, InfoIcon, SettingsIcon } from "lucide-react";
import {
  lazy,
  type ReactElement,
  type ReactNode,
  Suspense,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { SkillSourceBadge } from "../chat/ComposerCommandMenu";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { Switch } from "../ui/switch";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

// Loaded on first open so the chat view does not carry settings-page code.
const SkillMonitorSettingsDialog = lazy(() =>
  import("../settings/SkillMonitorSettings").then((module) => ({
    default: module.SkillMonitorSettingsDialog,
  })),
);

/** Harnesses that get their own on/off column, in column order. */
const HARNESSES = [
  { driver: "claudeAgent", name: "Claude Code" },
  { driver: "codex", name: "Codex" },
] as const;

interface SkillRow {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  /** The thread provider's copy when it has one, for the path and source. */
  readonly skill: ServerProviderSkill;
  /** Each column provider's copy of the skill, by instance. */
  readonly byInstance: ReadonlyMap<ProviderInstanceId, ServerProviderSkill>;
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

/** The metric columns the Skill Monitor settings turn on, in display order. */
function metricColumns(display: SkillMonitorSettings): ReadonlyArray<Column> {
  const tokens = (key: string, header: string, pick: (usage: SkillUsage) => number): Column => ({
    key,
    header,
    hint: "Average per completed run, subagents included",
    value: (row) => {
      const usage = completed(row.usage);
      return usage === undefined ? null : pick(usage);
    },
    render: (row) => {
      const usage = completed(row.usage);
      return usage === undefined ? "—" : formatTokens(pick(usage));
    },
  });
  const time = (key: string, header: string, pick: (usage: SkillUsage) => number): Column => ({
    key,
    header,
    hint: "Average per completed run",
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
      hint: "Turns the skill ran in, finished or not",
      value: (row) => usesIn(row.usage, days),
      render: (row) => String(usesIn(row.usage, days)),
    })),
    ...(display.showAverageCachedTokens
      ? [tokens("cached", "Cached", (usage) => usage.avgCachedInputTokens)]
      : []),
    ...(display.showAverageInputTokens
      ? [tokens("input", "Input", (usage) => usage.avgInputTokens)]
      : []),
    ...(display.showAverageOutputTokens
      ? [tokens("output", "Output", (usage) => usage.avgOutputTokens)]
      : []),
    ...(display.showAverageTotalTime
      ? [time("total", "Total time", (usage) => usage.avgTotalMs)]
      : []),
    ...(display.showAverageModelTime ? [time("model", "Model", (usage) => usage.avgModelMs)] : []),
    ...(display.showAverageToolTime ? [time("tools", "Tools", (usage) => usage.avgToolMs)] : []),
    ...(display.showAverageWaitingTime
      ? [time("waiting", "Waiting", (usage) => usage.avgWaitingMs)]
      : []),
    ...(display.showSlowestTool
      ? [
          {
            key: "slowest",
            header: "Slowest tool",
            hint: "The tool with the most time per completed run",
            value: (row: SkillRow) => slowestPerRun(row.usage),
            render: (row: SkillRow) => <SlowestTool usage={timed(row.usage)} />,
          },
        ]
      : []),
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
  columns: ReadonlyArray<Column>,
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

const pendingKey = (instanceId: ProviderInstanceId, skillName: string) =>
  `${instanceId}\u0000${skillName}`;

/**
 * Skill Monitor surface: a table of the skills the thread's provider and the
 * installed Claude Code and Codex list for its workspace, with an on/off
 * switch per harness, what each skill adds to every session, and what its
 * runs cost. Clicking a name opens its SKILL.md.
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
      input: { usageWindowsDays: display.usageWindowsDays },
    }),
  ).data;
  const setSkillEnabled = useAtomCommand(serverEnvironment.setSkillEnabled, "skill toggle");
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  // The switch shows where it is headed until the rescan reports back.
  const [pending, setPending] = useState<ReadonlyMap<string, boolean>>(new Map());
  const [sort, setSort] = useState<Sort>(null);
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

  // The thread's composer scans its own provider; scan the other harnesses
  // once too, or their project skills would be missing.
  const scanned = useRef(new Set<string>());
  useEffect(() => {
    if (cwd === null) return;
    for (const source of sources) {
      const key = `${source.instanceId}:${cwd}`;
      if (scanned.current.has(key)) continue;
      if (source.workspaceSnapshots?.some((snapshot) => snapshot.cwd === cwd)) continue;
      scanned.current.add(key);
      void refreshProviders({
        environmentId: threadRef.environmentId,
        input: { instanceId: source.instanceId, cwd },
      });
    }
  }, [cwd, refreshProviders, sources, threadRef.environmentId]);

  const rows = useMemo(() => {
    const usageBySkill = new Map(usageSummary?.skills.map((usage) => [usage.skillName, usage]));
    const byName = new Map<
      string,
      { first: ServerProviderSkill; byInstance: Map<ProviderInstanceId, ServerProviderSkill> }
    >();
    for (const source of sources) {
      for (const skill of dedupeProviderSkillsByName(resolveProviderSkillsForCwd(source, cwd))) {
        const entry = byName.get(skill.name) ?? { first: skill, byInstance: new Map() };
        entry.byInstance.set(source.instanceId, skill);
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
  }, [cwd, provider, sources, usageSummary]);
  const columns = useMemo(() => metricColumns(display), [display]);
  const sortedRows = useMemo(() => sortRows(rows, columns, sort), [rows, columns, sort]);
  const ambientTotal = rows.reduce((total, row) => total + (row.ambientTokens ?? 0), 0);

  const toggle = (source: ServerProvider, skillName: string, enabled: boolean) => {
    if (cwd === null) return;
    const key = pendingKey(source.instanceId, skillName);
    setPending((current) => new Map(current).set(key, enabled));
    void setSkillEnabled({
      environmentId: threadRef.environmentId,
      input: { instanceId: source.instanceId, cwd, skillName, enabled },
    }).finally(() =>
      setPending((current) => {
        const next = new Map(current);
        next.delete(key);
        return next;
      }),
    );
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
      {rows.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
          <BoxIcon aria-hidden className="size-6 text-muted-foreground/60" />
          <p className="text-sm font-medium">No skills found</p>
          <p className="max-w-60 text-xs text-muted-foreground">
            Skills the selected provider can start in this workspace show up here.
          </p>
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <Table variant="grid">
            <TableHeader>
              <TableRow>
                {harnesses.map((harness) => (
                  <TableHead key={harness.driver}>
                    <span className="flex justify-center">
                      <InstantTooltip
                        trigger={<span className="inline-flex" />}
                        content={`On in ${harness.name}`}
                      >
                        <ProviderInstanceIcon
                          driverKind={harness.provider.driver}
                          displayName={harness.provider.displayName ?? harness.name}
                          iconClassName="size-3.5"
                        />
                        <span className="sr-only">{harness.name}</span>
                      </InstantTooltip>
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
                  <TableHead key={column.key}>
                    <SortButton
                      sort={sort}
                      sortKey={column.key}
                      onSort={cycleSort}
                      {...(column.hint === undefined ? {} : { hint: column.hint })}
                    >
                      {column.header}
                    </SortButton>
                  </TableHead>
                ))}
              </TableRow>
            </TableHeader>
            <TableBody>
              {sortedRows.map((row) => {
                const isOn = (source: ServerProvider) => {
                  const copy = row.byInstance.get(source.instanceId);
                  return (
                    pending.get(pendingKey(source.instanceId, row.name)) ?? copy?.enabled ?? false
                  );
                };
                const dim = sources.some(isOn) ? undefined : "opacity-60";
                return (
                  <TableRow key={row.name}>
                    {harnesses.map((harness) => {
                      const listed = row.byInstance.has(harness.provider.instanceId);
                      const on = isOn(harness.provider);
                      return (
                        <TableCell key={harness.driver}>
                          {listed ? (
                            <Switch
                              size="sm"
                              checked={on}
                              disabled={
                                harness.provider.skillToggle !== true ||
                                cwd === null ||
                                pending.has(pendingKey(harness.provider.instanceId, row.name))
                              }
                              onCheckedChange={(checked) =>
                                toggle(harness.provider, row.name, checked)
                              }
                              aria-label={`${on ? "Turn off" : "Turn on"} ${row.label} in ${harness.name}`}
                            />
                          ) : (
                            <span className="text-muted-foreground">—</span>
                          )}
                        </TableCell>
                      );
                    })}
                    <TableCell>
                      <span className="flex max-w-64 min-w-32">
                        <InstantTooltip
                          disabled={row.description === ""}
                          trigger={
                            <button
                              type="button"
                              className={`min-w-0 truncate text-left font-medium hover:underline ${dim ?? ""}`}
                              onClick={() =>
                                useRightPanelStore.getState().openFile(threadRef, row.skill.path)
                              }
                            />
                          }
                          content={row.description}
                        >
                          {row.label}
                        </InstantTooltip>
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className={dim}>
                        <SkillSourceBadge kind={resolveProviderSkillSourceKind(row.skill)} />
                      </span>
                    </TableCell>
                    {columns.map((column) => (
                      <TableCell key={column.key}>
                        <span className={`tabular-nums ${dim ?? ""}`}>{column.render(row)}</span>
                      </TableCell>
                    ))}
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
      {settingsMounted ? (
        <Suspense fallback={null}>
          <SkillMonitorSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
        </Suspense>
      ) : null}
    </div>
  );
}

/** A tooltip that opens the moment its trigger is hovered. */
function InstantTooltip(props: {
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
