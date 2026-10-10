import type {
  EnvironmentId,
  ProviderDriverKind,
  SkillUsageDetail,
  SkillVersionLabel,
} from "@t3tools/contracts";
import { formatDateTimeShort } from "@t3tools/shared/usageFormat";
import type { ProviderSkillSourceKind } from "@t3tools/client-runtime/providerSkills";
import { ChevronDownIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { SkillSourceIcon } from "../chat/ComposerCommandMenu";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import {
  Menu,
  MenuCheckboxItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Spinner } from "../ui/spinner";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { niceScale } from "../usage/UsageProviderChart";
import {
  ALL_MODELS,
  CHART_METRICS,
  type ChartMetric,
  type ChartModel,
  chartModels,
  chartValue,
} from "./skillUsageChart";

// The combined series wears the app's accent. Models take categorical slots,
// light and dark, validated against the dialog surface and the default accent;
// the palette's blue and violet are left out as too close to it. A model keeps
// its slot by its rank in runs, whichever others are shown, so only the first
// six models chart on their own; the rest count toward All.
const ALL_MODELS_COLOR = "var(--primary)";
const MODEL_COLORS = [
  "light-dark(#eb6834, #d95926)",
  "light-dark(#1baf7a, #199e70)",
  "light-dark(#eda100, #c98500)",
  "light-dark(#e87ba4, #d55181)",
  "light-dark(#008300, #008300)",
  "light-dark(#e34948, #e66767)",
];
const TICK_COUNT = 4;

interface Series {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly driver: ProviderDriverKind | null;
}

const modelLabel = (model: ChartModel) => model.model ?? "Unknown model";
const versionTitle = (version: SkillVersionLabel) =>
  version.commit === null ? "Uncommitted" : version.commit.sha.slice(0, 7);
const versionDetail = (version: SkillVersionLabel) =>
  version.commit === null
    ? `Seen ${formatDateTimeShort(version.firstSeenAt)}`
    : version.commit.subject;

/** A skill the chart can show, and switch to from its title. */
export interface ChartSkill {
  readonly name: string;
  readonly label: string;
  readonly kind: ProviderSkillSourceKind;
}

/**
 * A skill's metrics across its versions, named after the commits that made
 * them, with one bar per chosen model. The title switches between `skills`,
 * starting on `skillName`. Loaded on first open.
 */
export function SkillUsageChartDialog(props: {
  environmentId: EnvironmentId;
  skillName: string;
  skills: ReadonlyArray<ChartSkill>;
  initialMetricKey: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [skillName, setSkillName] = useState(props.skillName);
  const skill = props.skills.find((candidate) => candidate.name === skillName);
  const skillChoices = useMemo(
    () => props.skills.toSorted((left, right) => left.label.localeCompare(right.label)),
    [props.skills],
  );
  const query = useEnvironmentQuery(
    serverEnvironment.skillUsageDetail({
      environmentId: props.environmentId,
      input: { skillName },
    }),
  );
  const detail = query.data;
  const [metricKey, setMetricKey] = useState(props.initialMetricKey);
  const metric =
    CHART_METRICS.find((candidate) => candidate.key === metricKey) ?? CHART_METRICS[0]!;
  const [selected, setSelected] = useState<ReadonlyArray<string>>([ALL_MODELS]);
  const [view, setView] = useState<"chart" | "table">("chart");
  const models = useMemo(
    () => (detail === null ? [] : chartModels(detail).slice(0, MODEL_COLORS.length)),
    [detail],
  );
  const series = useMemo(
    (): ReadonlyArray<Series> => [
      ...(selected.includes(ALL_MODELS)
        ? [{ key: ALL_MODELS, label: "All models", color: ALL_MODELS_COLOR, driver: null }]
        : []),
      ...models.flatMap((model, index) =>
        selected.includes(model.key)
          ? [
              {
                key: model.key,
                label: modelLabel(model),
                color: MODEL_COLORS[index]!,
                driver: model.driver,
              },
            ]
          : [],
      ),
    ],
    [models, selected],
  );
  // Another skill ran other models, so its chart starts on all of them.
  const switchSkill = (name: string) => {
    setSkillName(name);
    setSelected([ALL_MODELS]);
  };
  // The dialog stays mounted between opens, so each later open starts on the
  // skill it was opened for, and asks again rather than show what an earlier
  // open fetched.
  const [shownOpen, setShownOpen] = useState(props.open);
  if (shownOpen !== props.open) {
    setShownOpen(props.open);
    if (props.open) switchSkill(props.skillName);
  }
  const { refresh } = query;
  const wasOpen = useRef(props.open);
  useEffect(() => {
    if (props.open && !wasOpen.current) refresh();
    wasOpen.current = props.open;
  }, [props.open, refresh]);
  const toggleSeries = (key: string, checked: boolean) =>
    setSelected((current) =>
      checked ? [...current, key] : current.filter((candidate) => candidate !== key),
    );

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>
            <Menu>
              <MenuTrigger
                disabled={skillChoices.length < 2}
                render={
                  <button
                    type="button"
                    aria-label={`${skill?.label ?? skillName}, choose another skill`}
                    className="-mx-1 flex max-w-full items-center gap-2 rounded-md px-1 text-left outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none"
                  />
                }
              >
                {skill === undefined ? null : (
                  <SkillSourceIcon
                    kind={skill.kind}
                    className="size-5 shrink-0 text-muted-foreground"
                  />
                )}
                <span className="truncate">{skill?.label ?? skillName}</span>
                {skillChoices.length < 2 ? null : (
                  <ChevronDownIcon aria-hidden className="size-5 shrink-0 text-muted-foreground" />
                )}
              </MenuTrigger>
              <MenuPopup align="start">
                <MenuRadioGroup
                  value={skillName}
                  onValueChange={(value) => {
                    if (typeof value === "string") switchSkill(value);
                  }}
                >
                  {skillChoices.map((choice) => (
                    <MenuRadioItem key={choice.name} value={choice.name} closeOnClick>
                      <span className="flex items-center gap-2">
                        <SkillSourceIcon
                          kind={choice.kind}
                          className="size-4 shrink-0 text-muted-foreground"
                        />
                        {choice.label}
                      </span>
                    </MenuRadioItem>
                  ))}
                </MenuRadioGroup>
              </MenuPopup>
            </Menu>
          </DialogTitle>
          <DialogDescription>{metric.description}</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-wrap items-center gap-2">
              <ToggleGroup
                aria-label="Chart or table"
                variant="segmented"
                value={[view]}
                onValueChange={(next) => {
                  if (next[0] === "chart" || next[0] === "table") setView(next[0]);
                }}
              >
                <Toggle value="chart">Chart</Toggle>
                <Toggle value="table">Table</Toggle>
              </ToggleGroup>
              <div className="flex w-40">
                <Select
                  value={metric.key}
                  onValueChange={(value) => {
                    if (value !== null) setMetricKey(value);
                  }}
                >
                  <SelectTrigger size="xs" aria-label="Metric">
                    <SelectValue>
                      {(value: string | null) =>
                        CHART_METRICS.find((candidate) => candidate.key === value)?.label
                      }
                    </SelectValue>
                  </SelectTrigger>
                  <SelectPopup alignItemWithTrigger={false}>
                    {CHART_METRICS.map((candidate) => (
                      <SelectItem key={candidate.key} value={candidate.key}>
                        {candidate.label}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
              <Menu>
                <MenuTrigger render={<Button variant="outline" size="xs" />}>
                  {series.length > 1
                    ? `${series.length} series`
                    : (series[0]?.label ?? "All models")}
                  <ChevronDownIcon />
                </MenuTrigger>
                <MenuPopup align="start">
                  <MenuCheckboxItem
                    checked={selected.includes(ALL_MODELS)}
                    disabled={selected.length === 1 && selected.includes(ALL_MODELS)}
                    onCheckedChange={(checked) => toggleSeries(ALL_MODELS, checked)}
                  >
                    All models
                  </MenuCheckboxItem>
                  {models.length > 0 ? <MenuSeparator /> : null}
                  {models.map((model) => (
                    <MenuCheckboxItem
                      key={model.key}
                      checked={selected.includes(model.key)}
                      disabled={selected.length === 1 && selected.includes(model.key)}
                      onCheckedChange={(checked) => toggleSeries(model.key, checked)}
                    >
                      <span className="flex items-center gap-1.5">
                        {model.driver === null ? null : (
                          <ProviderInstanceIcon
                            driverKind={model.driver}
                            displayName={model.driver}
                            iconClassName="size-3.5"
                          />
                        )}
                        {modelLabel(model)}
                        <span className="text-muted-foreground tabular-nums">{model.runs}</span>
                      </span>
                    </MenuCheckboxItem>
                  ))}
                </MenuPopup>
              </Menu>
            </div>
            {detail === null ? (
              <div className="flex h-56 items-center justify-center text-xs text-muted-foreground">
                {query.error ?? <Spinner />}
              </div>
            ) : detail.versions.length === 0 ? (
              <div className="flex h-56 items-center justify-center text-xs text-muted-foreground">
                No completed runs yet.
              </div>
            ) : view === "chart" ? (
              <VersionChart detail={detail} metric={metric} series={series} />
            ) : (
              <VersionTable detail={detail} metric={metric} series={series} />
            )}
          </div>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

interface ChartProps {
  readonly detail: SkillUsageDetail;
  readonly metric: ChartMetric;
  readonly series: ReadonlyArray<Series>;
}

function useBars({ detail, metric, series }: ChartProps) {
  return useMemo(
    () =>
      detail.versions.map((version) => ({
        version,
        bars: series.map((entry) => ({
          series: entry,
          measured: chartValue({
            detail,
            metric,
            contentHash: version.contentHash,
            series: entry.key,
          }),
        })),
      })),
    [detail, metric, series],
  );
}

/** Grouped bars: one group per version, oldest first, one bar per series. */
function VersionChart(props: ChartProps) {
  const { metric, series } = props;
  const groups = useBars(props);
  const peak = groups.reduce(
    (max, group) =>
      group.bars.reduce((inner, bar) => Math.max(inner, bar.measured?.value ?? 0), max),
    0,
  );
  const { max, ticks } = niceScale(peak, TICK_COUNT);
  const percentOf = (value: number) => (max === 0 ? 0 : (value / max) * 100);
  const groupMinWidth = `${Math.max(6, series.length * 2.5)}rem`;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-2">
        {/* Axis labels sit outside the scroller so they stay put. */}
        <div className="relative h-56 w-14 shrink-0">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
              style={{ bottom: `${percentOf(tick)}%` }}
            >
              {tick === 0 ? "0" : metric.format(tick)}
            </span>
          ))}
        </div>
        <div className="min-w-0 flex-1 overflow-x-auto">
          <div className="flex w-max min-w-full flex-col">
            <div className="relative h-56">
              {ticks.map((tick) => (
                <span
                  key={tick}
                  aria-hidden
                  className="absolute inset-x-0 h-px bg-border"
                  style={{ bottom: `${percentOf(tick)}%` }}
                />
              ))}
              <div className="relative flex h-full">
                {groups.map((group) => (
                  <div
                    key={group.version.contentHash}
                    className="flex h-full flex-1 justify-center gap-0.5 px-6"
                    style={{ minWidth: groupMinWidth }}
                  >
                    {group.bars.map(({ series: entry, measured }) => (
                      <Tooltip key={entry.key} disabled={measured === null}>
                        <TooltipTrigger
                          delay={0}
                          closeDelay={0}
                          render={
                            <button
                              type="button"
                              disabled={measured === null}
                              aria-label={`${versionTitle(group.version)}, ${entry.label}: ${
                                measured === null
                                  ? "no runs"
                                  : `${metric.format(measured.value)} over ${measured.runs} ${
                                      measured.runs === 1 ? "run" : "runs"
                                    }`
                              }`}
                              className="group flex h-full max-w-20 flex-1 items-end rounded-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          }
                        >
                          {measured === null ? null : (
                            <span
                              className="block w-full rounded-t-sm group-hover:brightness-125 group-focus-visible:brightness-125"
                              style={{
                                height: `${percentOf(measured.value)}%`,
                                minHeight: 2,
                                background: entry.color,
                              }}
                            />
                          )}
                        </TooltipTrigger>
                        {measured === null ? null : (
                          <TooltipPopup>
                            <div className="flex flex-col gap-0.5 text-xs">
                              <span className="font-medium text-foreground tabular-nums">
                                {metric.format(measured.value)}
                              </span>
                              <span className="text-muted-foreground">
                                {entry.label} · {versionTitle(group.version)}
                              </span>
                              <span className="text-muted-foreground tabular-nums">
                                {measured.runs} {measured.runs === 1 ? "run" : "runs"}
                              </span>
                            </div>
                          </TooltipPopup>
                        )}
                      </Tooltip>
                    ))}
                  </div>
                ))}
              </div>
            </div>
            <div className="flex">
              {groups.map(({ version }) => (
                <div
                  key={version.contentHash}
                  className="flex min-w-0 flex-1 flex-col items-center px-1 pt-1.5 text-3xs"
                  style={{ minWidth: groupMinWidth }}
                >
                  <span className="font-mono text-foreground">{versionTitle(version)}</span>
                  <Tooltip>
                    <TooltipTrigger
                      render={<span className="max-w-full truncate text-muted-foreground" />}
                    >
                      {versionDetail(version)}
                    </TooltipTrigger>
                    <TooltipPopup>{versionDetail(version)}</TooltipPopup>
                  </Tooltip>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
      {series.length > 1 ? (
        <div className="flex flex-wrap gap-x-3 gap-y-1 pl-16 text-xs text-muted-foreground">
          {series.map((entry) => (
            <span key={entry.key} className="flex items-center gap-1.5">
              <span
                aria-hidden
                className="size-2.5 rounded-xs"
                style={{ background: entry.color }}
              />
              {entry.label}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** The chart's values as a table, newest version first. */
function VersionTable(props: ChartProps) {
  const { metric, series } = props;
  const groups = useBars(props);
  return (
    <Table variant="grid">
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          {series.map((entry) => (
            <TableHead key={entry.key}>{entry.label}</TableHead>
          ))}
        </TableRow>
      </TableHeader>
      <TableBody>
        {groups.toReversed().map(({ version, bars }) => (
          <TableRow key={version.contentHash}>
            <TableCell>
              <span className="flex max-w-72 flex-col">
                <span className="font-mono">{versionTitle(version)}</span>
                <span className="truncate text-muted-foreground">{versionDetail(version)}</span>
              </span>
            </TableCell>
            {bars.map(({ series: entry, measured }) => (
              <TableCell key={entry.key}>
                {measured === null ? (
                  "—"
                ) : (
                  <span className="tabular-nums">
                    {metric.format(measured.value)}{" "}
                    <span className="text-muted-foreground">
                      ({measured.runs} {measured.runs === 1 ? "run" : "runs"})
                    </span>
                  </span>
                )}
              </TableCell>
            ))}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
