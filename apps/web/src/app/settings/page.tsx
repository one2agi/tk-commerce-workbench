import { getServerServices } from "../../server/composition";
import type { WorkspaceSettingsView } from "../../server/services/settings-service";
import { SettingsWorkspace } from "../../components/settings/settings-workspace";
import type { Metadata } from "next";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "设置 · TK 商品自动化",
  description: "配置工作区默认值、图片生成路径与 Worker 运行参数。"
};

export function renderSettingsPage(settings: WorkspaceSettingsView) {
  return <SettingsWorkspace initial={settings} />;
}

export default async function SettingsPage() {
  const settings = await (await getServerServices()).settings.get();
  return <SettingsWorkspace initial={settings} />;
}
