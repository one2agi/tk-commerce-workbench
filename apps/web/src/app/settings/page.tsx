import type { WorkspaceSettingsViewV1 } from "@tk/contracts/read-models";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

function SecretStatus({ label, variables, configured }: { label: string; variables: string; configured: boolean }) {
  return <li><strong>{label}</strong><span>{configured ? "已配置" : "未配置"}</span><code>{variables}</code><small>请在本机环境变量中设置，浏览器不会读取或保存密钥。</small></li>;
}

export function renderSettingsPage(settings: WorkspaceSettingsViewV1) {
  return <section aria-label="工作区设置">
    <header className="tk-page-heading"><div><p>Local workspace</p><h1>设置</h1></div><span>单用户本地模式</span></header>
    <form className="tk-panel" aria-label="非敏感设置">
      <label>默认语言<input name="defaultLocale" defaultValue={settings.defaultLocale} /></label>
      <label>默认币种<input name="defaultCurrency" defaultValue={settings.defaultCurrency} /></label>
      <label>Provider 模式<select name="externalAdapterMode" defaultValue={settings.externalAdapterMode}><option value="mock">Mock</option><option value="live">Live</option></select></label>
      <label>素材目录<input name="assetRoot" defaultValue={settings.assetRoot} /></label>
      <label>Worker 并发<input name="workerConcurrency" type="number" min="1" defaultValue={settings.workerConcurrency} /></label>
      <label>Canvas 每日上限<input name="maxCanvasRunsPerDay" type="number" min="1" defaultValue={settings.maxCanvasRunsPerDay} /></label>
      <label>失败重试次数<input name="maxAttempts" type="number" min="1" defaultValue="3" /></label>
      <button type="button">保存非敏感设置</button>
    </form>
    <section className="tk-panel" aria-label="密钥配置状态"><h2>密钥配置状态</h2><ul className="tk-secret-status">
      <SecretStatus label="妙手" variables="MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET" configured={settings.secretStatus.miaoshouConfigured} />
      <SecretStatus label="Canvas" variables="CANVAS_API_KEY" configured={settings.secretStatus.canvasConfigured} />
      <SecretStatus label="LLM" variables="LLM_API_KEY" configured={settings.secretStatus.llmConfigured} />
      <SecretStatus label="汇率" variables="EXCHANGE_RATE_API_KEY" configured={settings.secretStatus.exchangeRateConfigured} />
    </ul></section>
  </section>;
}

export default async function SettingsPage() {
  return renderSettingsPage((await getServerServices()).settings.get());
}
