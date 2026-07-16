import { getServerServices } from "../../server/composition";
import type { WorkspaceSettingsView } from "../../server/services/settings-service";
import { SettingsEditor } from "../../components/settings/settings-editor";

export const dynamic = "force-dynamic";

function SecretStatus({ label, variables, configured }: { label: string; variables: string; configured: boolean }) {
  return <li><strong>{label}</strong><span>{configured ? "已配置" : "未配置"}</span><code>{variables}</code><small>请在本机环境变量中设置，浏览器不会读取或保存密钥。</small></li>;
}

export function renderSettingsPage(settings: WorkspaceSettingsView) {
  return <section aria-label="工作区设置">
    <header className="tk-page-heading"><div><p>Local workspace</p><h1>设置</h1></div><span>单用户本地模式</span></header>
    <SettingsEditor settings={settings} />
    <section className="tk-panel" aria-label="密钥配置状态"><h2>密钥配置状态</h2><ul className="tk-secret-status">
      <SecretStatus label="妙手" variables="MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET" configured={settings.secretStatus.miaoshouConfigured} />
      <SecretStatus label="Canvas" variables="CANVAS_API_KEY" configured={settings.secretStatus.canvasConfigured} />
      <SecretStatus label="LLM" variables="LLM_API_KEY" configured={settings.secretStatus.llmConfigured} />
      <SecretStatus label="汇率" variables="EXCHANGE_RATE_API_KEY" configured={settings.secretStatus.exchangeRateConfigured} />
    </ul></section>
  </section>;
}

export default async function SettingsPage() {
  return renderSettingsPage(await (await getServerServices()).settings.get());
}
