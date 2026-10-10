import {
  estimateSkillAmbientTokens,
  formatProviderSkillDisplayName,
  resolveProviderSkillSourceKind,
} from "@t3tools/client-runtime/providerSkills";
import type {
  ProviderInstanceId,
  ScopedThreadRef,
  ServerProvider,
  SkillInventorySkill,
} from "@t3tools/contracts";
import { ChartColumnIcon } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";

import { useClientSettings } from "~/hooks/useSettings";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { Button } from "../ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "../ui/table";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { orderColumns } from "./columnOrder";
import { chartMetricForColumn } from "./skillUsageChart";
import type { ChartSkill } from "./SkillUsageChartDialog";
import { InstantTooltip, metricColumns, type SkillRow } from "./SkillMonitorPanel";

// Loaded on first open so the file view does not carry chart code.
const SkillUsageChartDialog = lazy(() =>
  import("./SkillUsageChartDialog").then((module) => ({
    default: module.SkillUsageChartDialog,
  })),
);

const SKILL_FILE = /(?:^|[\\/])SKILL\.md$/;

/**
 * Above a skill's SKILL.md, the Skill Monitor's metric columns for that skill
 * alone, and a chart of them across its versions and models. Nothing for
 * other files, or a SKILL.md no provider lists.
 */
export function SkillFileMetrics(props: {
  threadRef: ScopedThreadRef;
  provider: ServerProvider | null;
  absolutePath: string;
}) {
  return SKILL_FILE.test(props.absolutePath) ? <SkillFileMetricsRow {...props} /> : null;
}

function SkillFileMetricsRow(props: {
  threadRef: ScopedThreadRef;
  provider: ServerProvider | null;
  absolutePath: string;
}) {
  const { threadRef, provider, absolutePath } = props;
  const display = useClientSettings((settings) => settings.skillMonitor);
  const inventory = useEnvironmentQuery(
    serverEnvironment.skillInventory({ environmentId: threadRef.environmentId, input: {} }),
  ).data;
  const usageSummary = useEnvironmentQuery(
    serverEnvironment.skillUsageSummary({
      environmentId: threadRef.environmentId,
      input: { usageWindowsDays: display.usageWindowsDays, tools: display.toolColumns },
    }),
  ).data;
  const [chartOpen, setChartOpen] = useState(false);
  // Stays mounted after the first open so closing can animate.
  const [chartMounted, setChartMounted] = useState(false);

  // Built like the Skill Monitor's row for the skill at this path.
  const row = useMemo((): SkillRow | null => {
    const listings = inventory?.providers ?? [];
    const name = listings
      .flatMap((listing) => listing.skills)
      .find((skill) => skill.path === absolutePath)?.name;
    if (name === undefined) return null;
    const byInstance = new Map<ProviderInstanceId, SkillInventorySkill>();
    for (const listing of listings) {
      const copy = listing.skills.find((skill) => skill.name === name);
      if (copy !== undefined) byInstance.set(listing.instanceId, copy);
    }
    const own = provider === null ? undefined : byInstance.get(provider.instanceId);
    const skill = own ?? byInstance.values().next().value;
    if (skill === undefined) return null;
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
      usage: usageSummary?.skills.find((usage) => usage.skillName === name),
    };
  }, [absolutePath, inventory, provider, usageSummary]);
  // The skills the chart can switch to: every listed skill the Skill Monitor
  // shows, and this one even when it is hidden.
  const chartSkills = useMemo(() => {
    const hidden = new Set(inventory?.hiddenSkills);
    const byName = new Map<string, ChartSkill>();
    for (const skill of (inventory?.providers ?? []).flatMap((listing) => listing.skills)) {
      if (byName.has(skill.name) || (hidden.has(skill.name) && skill.name !== row?.name)) {
        continue;
      }
      byName.set(skill.name, {
        name: skill.name,
        label: formatProviderSkillDisplayName(skill),
        kind: resolveProviderSkillSourceKind(skill),
      });
    }
    return [...byName.values()];
  }, [inventory, row?.name]);
  const driver = provider?.driver ?? null;
  const columns = useMemo(
    () => orderColumns(metricColumns(display, driver), display.columnOrder),
    [display, driver],
  );
  if (row === null) return null;
  const initialMetricKey =
    columns.map((column) => chartMetricForColumn(column.key)).find((metric) => metric)?.key ??
    "runs";

  return (
    <div className="flex shrink-0 items-start gap-1 border-b border-border/60 py-1 pr-1.5">
      <div className="min-w-0 flex-1">
        <Table variant="grid">
          <TableHeader>
            <TableRow>
              {columns.map((column) => (
                <TableHead key={column.key}>
                  {column.hint === undefined ? (
                    column.header
                  ) : (
                    <InstantTooltip trigger={<span />} content={column.hint}>
                      {column.header}
                    </InstantTooltip>
                  )}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            <TableRow>
              {columns.map((column) => (
                <TableCell key={column.key}>
                  <span className="tabular-nums">{column.render(row)}</span>
                </TableCell>
              ))}
            </TableRow>
          </TableBody>
        </Table>
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label="Compare versions and models"
              onClick={() => {
                setChartMounted(true);
                setChartOpen(true);
              }}
            />
          }
        >
          <ChartColumnIcon />
        </TooltipTrigger>
        <TooltipPopup>Compare versions and models</TooltipPopup>
      </Tooltip>
      {chartMounted ? (
        <Suspense fallback={null}>
          <SkillUsageChartDialog
            environmentId={threadRef.environmentId}
            skillName={row.name}
            skills={chartSkills}
            initialMetricKey={initialMetricKey}
            open={chartOpen}
            onOpenChange={setChartOpen}
          />
        </Suspense>
      ) : null}
    </div>
  );
}
