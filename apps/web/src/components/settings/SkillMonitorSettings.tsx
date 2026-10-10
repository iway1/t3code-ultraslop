import {
  DEFAULT_CLIENT_SETTINGS,
  type EnvironmentId,
  MAX_SKILL_TOOL_COLUMNS,
  MAX_SKILL_USAGE_WINDOW_DAYS,
  MAX_SKILL_USAGE_WINDOWS,
  MIN_SKILL_USAGE_WINDOW_DAYS,
  SKILL_RECENT_SESSION_DAYS,
  type SkillMonitorSettings as SkillMonitorSettingsValue,
  type SkillToolRef,
} from "@t3tools/contracts";
import { EyeIcon, XIcon } from "lucide-react";
import { useMemo, useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { usePrimaryEnvironmentId } from "~/state/environments";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  Autocomplete,
  AutocompleteEmpty,
  AutocompleteInput,
  AutocompleteItem,
  AutocompleteList,
  AutocompletePopup,
} from "../ui/autocomplete";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const DEFAULTS = DEFAULT_CLIENT_SETTINGS.skillMonitor;

type ToggleKey = {
  [Key in keyof SkillMonitorSettingsValue]: SkillMonitorSettingsValue[Key] extends boolean
    ? Key
    : never;
}[keyof SkillMonitorSettingsValue];

const TOKEN_OPTIONS: ReadonlyArray<{ key: ToggleKey; label: string }> = [
  { key: "showAmbientTokens", label: "Ambient" },
  { key: "showAverageCachedTokens", label: "Cached" },
  { key: "showAverageInputTokens", label: "Input" },
  { key: "showAverageOutputTokens", label: "Output" },
];

const TIME_OPTIONS: ReadonlyArray<{ key: ToggleKey; label: string }> = [
  { key: "showAverageTotalTime", label: "Total" },
  { key: "showAverageModelTime", label: "Model" },
  { key: "showAverageToolTime", label: "Tools" },
  { key: "showAverageWaitingTime", label: "Waiting" },
  { key: "showSlowestTool", label: "Slowest tool" },
];

const LIMIT_OPTIONS: ReadonlyArray<{ key: ToggleKey; label: string }> = [
  { key: "showAverageSessionLimit", label: "5-hour" },
  { key: "showAverageWeeklyLimit", label: "Weekly" },
  { key: "showRecentSessionLimit", label: `5-hour (${SKILL_RECENT_SESSION_DAYS} days)` },
];

// Matches only so many tools at once; typing narrows the rest.
const MAX_TOOL_MATCHES = 50;
// Skill names are never empty, so this cannot be one.
const ALL_SKILLS = "";

const sameTool = (left: SkillToolRef, right: SkillToolRef) =>
  left.kind === right.kind && left.label === right.label;

/** The Skill Monitor tab in Settings, picking tools from the primary environment's runs. */
export function SkillMonitorSettingsPage() {
  const environmentId = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      <SettingsSection id="skill-monitor" title="Skill Monitor">
        <SkillMonitorSettingsRows environmentId={environmentId} />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** The same settings, opened from the cog in the Skill Monitor panel. */
export function SkillMonitorSettingsDialog(props: {
  environmentId: EnvironmentId;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogPopup>
        <DialogHeader>
          <DialogTitle>Skill Monitor settings</DialogTitle>
          <DialogDescription>Choose what shows under each skill.</DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <SettingsSection title="Skill Monitor" hideTitle>
            <SkillMonitorSettingsRows environmentId={props.environmentId} />
          </SettingsSection>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * What the Skill Monitor shows under each skill: token averages, usage windows,
 * and tool columns. A client setting, so it reads and writes this device
 * directly; tools to add are picked from `environmentId`'s runs.
 */
function SkillMonitorSettingsRows(props: { environmentId: EnvironmentId | null }) {
  const skillMonitor = useClientSettings((settings) => settings.skillMonitor);
  const updateSettings = useUpdateClientSettings();
  const update = (patch: Partial<SkillMonitorSettingsValue>) =>
    updateSettings({ skillMonitor: { ...skillMonitor, ...patch } });
  const windowsChanged = skillMonitor.usageWindowsDays.join() !== DEFAULTS.usageWindowsDays.join();
  const checkboxRow = (input: {
    searchId: "skill-monitor-averages" | "skill-monitor-time" | "skill-monitor-usage-limits";
    description: string;
    resetLabel: string;
    options: ReadonlyArray<{ key: ToggleKey; label: string }>;
  }) => (
    <SettingsRow
      {...searchableSetting(input.searchId)}
      description={input.description}
      resetAction={
        input.options.some(({ key }) => skillMonitor[key] !== DEFAULTS[key]) ? (
          <SettingResetButton
            label={input.resetLabel}
            onClick={() =>
              update(Object.fromEntries(input.options.map(({ key }) => [key, DEFAULTS[key]])))
            }
          />
        ) : null
      }
      control={
        <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1.5">
          {input.options.map(({ key, label }) => (
            <label key={key} className="flex cursor-pointer items-center gap-1.5 text-xs">
              <Checkbox
                checked={skillMonitor[key]}
                onCheckedChange={(checked) => update({ [key]: checked === true })}
              />
              {label}
            </label>
          ))}
        </div>
      }
    />
  );

  return (
    <>
      {checkboxRow({
        searchId: "skill-monitor-averages",
        description:
          "Estimated tokens each skill adds to every new session, and averages per completed run",
        resetLabel: "tokens used",
        options: TOKEN_OPTIONS,
      })}
      {checkboxRow({
        searchId: "skill-monitor-time",
        description: "Average time per completed run, and the tool that took the longest",
        resetLabel: "time spent",
        options: TIME_OPTIONS,
      })}
      {checkboxRow({
        searchId: "skill-monitor-usage-limits",
        description: `Estimated share of your Claude Code or Codex usage limits per completed run, and of the 5-hour limit over the last ${SKILL_RECENT_SESSION_DAYS} days`,
        resetLabel: "usage limits",
        options: LIMIT_OPTIONS,
      })}
      <SettingsRow
        {...searchableSetting("skill-monitor-usage-windows")}
        description="Show how many times each skill ran over each of these periods."
        resetAction={
          windowsChanged ? (
            <SettingResetButton
              label="Skill Monitor usage windows"
              onClick={() => update({ usageWindowsDays: DEFAULTS.usageWindowsDays })}
            />
          ) : null
        }
        control={
          <UsageWindowsInput
            value={skillMonitor.usageWindowsDays}
            onChange={(usageWindowsDays) => update({ usageWindowsDays })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("skill-monitor-tool-columns")}
        description="Give a tool or command its own column: the average time a completed run spends on it."
        resetAction={
          skillMonitor.toolColumns.length > 0 ? (
            <SettingResetButton
              label="Skill Monitor tool columns"
              onClick={() => update({ toolColumns: DEFAULTS.toolColumns })}
            />
          ) : null
        }
        control={
          <ToolColumnsInput
            environmentId={props.environmentId}
            value={skillMonitor.toolColumns}
            onChange={(toolColumns) => update({ toolColumns })}
          />
        }
      />
      <SettingsRow
        {...searchableSetting("skill-monitor-column-order")}
        description="Drag a column's header in the Skill Monitor to move it."
        resetAction={
          skillMonitor.columnOrder.length > 0 ? (
            <SettingResetButton
              label="Skill Monitor column order"
              onClick={() => update({ columnOrder: DEFAULTS.columnOrder })}
            />
          ) : null
        }
      />
      <HiddenSkillsRow environmentId={props.environmentId} />
    </>
  );
}

/**
 * The skills hidden from the Skill Monitor on `environmentId`. They are kept
 * by that server, not this device, since hiding one switched it off there.
 */
function HiddenSkillsRow(props: { environmentId: EnvironmentId | null }) {
  const { environmentId } = props;
  const inventory = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.skillInventory({ environmentId, input: {} }),
  ).data;
  const setSkillHidden = useAtomCommand(serverEnvironment.setSkillHidden, "show skill");
  const [showing, setShowing] = useState<ReadonlySet<string>>(new Set());
  const hidden = inventory?.hiddenSkills ?? [];
  const show = (skillName: string) => {
    if (environmentId === null) return;
    setShowing((current) => new Set(current).add(skillName));
    void setSkillHidden({ environmentId, input: { skillName, hidden: false } }).then(() =>
      setShowing((current) => {
        const next = new Set(current);
        next.delete(skillName);
        return next;
      }),
    );
  };

  return (
    <SettingsRow
      {...searchableSetting("skill-monitor-hidden-skills")}
      description={
        hidden.length === 0
          ? "Skills you hide in the Skill Monitor show up here, to bring back."
          : "Showing a skill again turns it back on in Claude Code and Codex for every project."
      }
      control={
        hidden.length === 0 ? null : (
          <div className="flex flex-wrap items-center justify-end gap-1.5">
            {hidden.map((skillName) => (
              <Button
                key={skillName}
                size="xs"
                variant="outline"
                disabled={showing.has(skillName)}
                aria-label={`Show ${skillName} again and turn it on`}
                onClick={() => show(skillName)}
              >
                <EyeIcon />
                {skillName}
              </Button>
            ))}
          </div>
        )
      }
    />
  );
}

function UsageWindowsInput(props: {
  value: ReadonlyArray<number>;
  onChange: (days: ReadonlyArray<number>) => void;
}) {
  const [draft, setDraft] = useState("");
  // Number(), not parseInt: "3.5" must be rejected rather than added as 3.
  const days = Number(draft);
  const canAdd =
    draft.trim() !== "" &&
    Number.isInteger(days) &&
    days >= MIN_SKILL_USAGE_WINDOW_DAYS &&
    days <= MAX_SKILL_USAGE_WINDOW_DAYS &&
    !props.value.includes(days) &&
    props.value.length < MAX_SKILL_USAGE_WINDOWS;
  const add = () => {
    if (!canAdd) return;
    props.onChange([...props.value, days].toSorted((left, right) => left - right));
    setDraft("");
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {props.value.map((windowDays) => (
        <Button
          key={windowDays}
          size="xs"
          variant="outline"
          aria-label={`Remove the ${windowDays}-day window`}
          onClick={() => props.onChange(props.value.filter((entry) => entry !== windowDays))}
        >
          {windowDays === 1 ? "1 day" : `${windowDays} days`}
          <XIcon />
        </Button>
      ))}
      <Input
        size="sm"
        type="number"
        min={MIN_SKILL_USAGE_WINDOW_DAYS}
        max={MAX_SKILL_USAGE_WINDOW_DAYS}
        placeholder="Days"
        className="w-20"
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Enter") add();
        }}
        aria-label="Days in a new usage window"
      />
      <Button size="xs" variant="outline" disabled={!canAdd} onClick={add}>
        Add
      </Button>
    </div>
  );
}

/**
 * One chip per tool column, and a search over the tools completed skill runs
 * called, most runs first, narrowed to one skill's runs if picked. The list
 * loads the first time either control opens.
 */
function ToolColumnsInput(props: {
  environmentId: EnvironmentId | null;
  value: ReadonlyArray<SkillToolRef>;
  onChange: (tools: ReadonlyArray<SkillToolRef>) => void;
}) {
  const [opened, setOpened] = useState(false);
  const [skillName, setSkillName] = useState(ALL_SKILLS);
  const [query, setQuery] = useState("");
  const catalogFor = (name: string | null) =>
    opened && props.environmentId !== null
      ? serverEnvironment.skillToolCatalog({
          environmentId: props.environmentId,
          input: { skillName: name },
        })
      : null;
  // Every skill's catalog names the skills to filter by, so the list stays put
  // while one skill's tools load.
  const allQuery = useEnvironmentQuery(catalogFor(null));
  const skillQuery = useEnvironmentQuery(skillName === ALL_SKILLS ? null : catalogFor(skillName));
  const catalogQuery = skillName === ALL_SKILLS ? allQuery : skillQuery;
  const catalog = catalogQuery.data;
  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (catalog?.tools ?? [])
      .filter(
        (tool) =>
          tool.label.toLowerCase().includes(needle) &&
          !props.value.some((column) => sameTool(column, tool)),
      )
      .slice(0, MAX_TOOL_MATCHES);
  }, [catalog, props.value, query]);
  const full = props.value.length >= MAX_SKILL_TOOL_COLUMNS;
  const disabled = full || props.environmentId === null;
  const onOpenChange = (open: boolean) => {
    if (open) setOpened(true);
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-1.5">
      {props.value.map((tool) => (
        <Button
          key={`${tool.kind}:${tool.label}`}
          size="xs"
          variant="outline"
          aria-label={`Remove the ${tool.label} column`}
          onClick={() => props.onChange(props.value.filter((column) => !sameTool(column, tool)))}
        >
          {tool.label}
          <XIcon />
        </Button>
      ))}
      <div className="w-36">
        <Select
          value={skillName}
          onValueChange={(value) => setSkillName(value ?? ALL_SKILLS)}
          onOpenChange={onOpenChange}
          disabled={disabled}
        >
          <SelectTrigger size="xs" aria-label="Tools from one skill's runs">
            <SelectValue>
              {(value: string | null) =>
                value === null || value === ALL_SKILLS ? "All skills" : value
              }
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value={ALL_SKILLS}>All skills</SelectItem>
            {allQuery.data?.skillNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      </div>
      <Autocomplete
        items={matches}
        itemToStringValue={(tool) => tool.label}
        mode="none"
        openOnInputClick
        autoHighlight
        value={query}
        // A picked tool becomes a chip, so the search starts over.
        onValueChange={(value, eventDetails) =>
          setQuery(eventDetails.reason === "item-press" ? "" : value)
        }
        onOpenChange={onOpenChange}
      >
        <div className="w-48">
          <AutocompleteInput
            size="sm"
            placeholder={full ? `Up to ${MAX_SKILL_TOOL_COLUMNS} columns` : "Add a tool or command"}
            disabled={disabled}
            spellCheck={false}
            aria-label="Search tools and commands to add as columns"
          />
        </div>
        <AutocompletePopup align="end">
          {matches.length > 0 ? (
            <AutocompleteList className="max-h-72">
              {matches.map((tool) => (
                <AutocompleteItem
                  key={`${tool.kind}:${tool.label}`}
                  value={tool}
                  onClick={() =>
                    props.onChange([...props.value, { kind: tool.kind, label: tool.label }])
                  }
                >
                  <span className="min-w-0 flex-1 truncate">{tool.label}</span>
                  <span className="shrink-0 text-muted-foreground text-xs tabular-nums">
                    {tool.kind} · {tool.runs === 1 ? "1 run" : `${tool.runs} runs`}
                  </span>
                </AutocompleteItem>
              ))}
            </AutocompleteList>
          ) : (
            <AutocompleteEmpty>
              {catalog === null
                ? (catalogQuery.error ?? "Loading…")
                : catalog.tools.length === 0
                  ? "No tool calls recorded yet."
                  : "No tools match."}
            </AutocompleteEmpty>
          )}
        </AutocompletePopup>
      </Autocomplete>
    </div>
  );
}
