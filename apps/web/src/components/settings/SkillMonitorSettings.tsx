import {
  DEFAULT_CLIENT_SETTINGS,
  MAX_SKILL_USAGE_WINDOW_DAYS,
  MAX_SKILL_USAGE_WINDOWS,
  MIN_SKILL_USAGE_WINDOW_DAYS,
  type SkillMonitorSettings as SkillMonitorSettingsValue,
} from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useState } from "react";

import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
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

/** The Skill Monitor tab in Settings. */
export function SkillMonitorSettingsPage() {
  return (
    <SettingsPageContainer>
      <SettingsSection id="skill-monitor" title="Skill Monitor">
        <SkillMonitorSettingsRows />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

/** The same settings, opened from the cog in the Skill Monitor panel. */
export function SkillMonitorSettingsDialog(props: {
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
            <SkillMonitorSettingsRows />
          </SettingsSection>
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}

/**
 * What the Skill Monitor shows under each skill: token averages and usage
 * windows. A client setting, so it reads and writes this device directly.
 */
function SkillMonitorSettingsRows() {
  const skillMonitor = useClientSettings((settings) => settings.skillMonitor);
  const updateSettings = useUpdateClientSettings();
  const update = (patch: Partial<SkillMonitorSettingsValue>) =>
    updateSettings({ skillMonitor: { ...skillMonitor, ...patch } });
  const windowsChanged = skillMonitor.usageWindowsDays.join() !== DEFAULTS.usageWindowsDays.join();
  const checkboxRow = (input: {
    searchId: "skill-monitor-averages" | "skill-monitor-time";
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
    </>
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
