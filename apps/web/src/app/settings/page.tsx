import { getServerServices } from "../../server/composition";
import type { WorkspaceSettingsView } from "../../server/services/settings-service";
import { SettingsWorkspace } from "../../components/settings/settings-workspace";

export const dynamic = "force-dynamic";

export function renderSettingsPage(settings: WorkspaceSettingsView) {
  return <SettingsWorkspace initial={settings} />;
}

export default async function SettingsPage() {
  const settings = await (await getServerServices()).settings.get();
  return <SettingsWorkspace initial={settings} />;
}
