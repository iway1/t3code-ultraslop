import { createFileRoute } from "@tanstack/react-router";

import { SkillMonitorSettingsPage } from "../components/settings/SkillMonitorSettings";

function SettingsSkillMonitorRoute() {
  return <SkillMonitorSettingsPage />;
}

export const Route = createFileRoute("/settings/skill-monitor")({
  component: SettingsSkillMonitorRoute,
});
