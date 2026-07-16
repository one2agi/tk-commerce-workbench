import type { WorkspaceSettingsViewV1 } from "@tk/contracts/read-models";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

function SecretStatus({ label, variables, configured }: { label: string; variables: string; configured: boolean }) {
  return <li><strong>{label}</strong><span>{configured ? "已配置" : "未配置"}</span><code>{variables}</code><small>请在本机环境变量中设置，浏览器不会读取或保存密钥。</small></li>;
}

export function renderSettingsPage(settings: WorkspaceSettingsViewV1) {
  return <section aria-label="工作区设置">
    <header className="tk-page-heading"><div><p>Local workspace</p><h1>设置</h1></div><span>单用户本地模式</span></header>
    <form className="tk-panel" aria-label="非敏感设置（当前只读）">
      <p>当前只读，保存尚未开放。以下值来自本地运行配置。</p>
      <label>默认语言<input name="defaultLocale" value={settings.defaultLocale} readOnly /></label>
      <label>默认币种<input name="defaultCurrency" value={settings.defaultCurrency} readOnly /></label>
      <label>Provider 模式<input name="externalAdapterMode" value={settings.externalAdapterMode} readOnly /></label>
      <label>素材目录<input name="assetRoot" value={settings.assetRoot} readOnly /></label>
      <label>Worker 并发<input name="workerConcurrency" value={String(settings.workerConcurrency)} readOnly /></label>
      <label>Canvas 每日上限<input name="maxCanvasRunsPerDay" value={String(settings.maxCanvasRunsPerDay)} readOnly /></label>
      <button type="button" disabled>当前只读，保存尚未开放</button>
    </form>
    <section className="tk-panel" aria-label="定价公式（当前只读）">
      <h2>定价公式（当前只读）</h2>
      <p>目标价 =（货品成本 + 国内运费 + 跨境成本）× CNY→THB 汇率 + 固定成本，再按费用率与利润率倒推并向上调整尾数。</p>
      <dl>
        <div><dt>固定目标成本</dt><dd>0 THB</dd></div>
        <div><dt>平台费率</dt><dd>平台费率 0.05</dd></div>
        <div><dt>支付费率</dt><dd>支付费率 0.03</dd></div>
        <div><dt>目标利润率</dt><dd>目标利润率 0.30</dd></div>
        <div><dt>尾数</dt><dd>尾数 9</dd></div>
      </dl>
      <p>商品成本、运费、重量和汇率属于每个商品/运行的证据值，不在此页面伪造或修改。</p>
    </section>
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
