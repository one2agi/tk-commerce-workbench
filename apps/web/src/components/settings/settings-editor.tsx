"use client";

import { useState, type FormEvent } from "react";
import type { WorkspaceSettingsView } from "../../server/services/settings-service";

export function SettingsEditor({ settings }: { settings: WorkspaceSettingsView }) {
  const [message, setMessage] = useState("");

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        expectedVersion: settings.version,
        defaultLocale: data.get("defaultLocale"),
        defaultCurrency: data.get("defaultCurrency"),
        externalAdapterMode: data.get("externalAdapterMode"),
        assetRoot: data.get("assetRoot"),
        workerConcurrency: Number(data.get("workerConcurrency")),
        maxCanvasRunsPerDay: Number(data.get("maxCanvasRunsPerDay")),
        pricingDefaults: {
          domesticShippingCny: data.get("domesticShippingCny"),
          crossBorderCostCny: data.get("crossBorderCostCny"),
          fixedTargetCostThb: data.get("fixedTargetCostThb"),
          platformFeeRate: data.get("platformFeeRate"),
          paymentFeeRate: data.get("paymentFeeRate"),
          targetProfitRate: data.get("targetProfitRate"),
          ending: data.get("ending")
        },
        providerOptions: {
          listingProvider: data.get("listingProvider"),
          listingModel: data.get("listingModel"),
          canvasWorkflow: data.get("canvasWorkflow")
        },
        retryPolicy: {
          maxAttempts: Number(data.get("maxAttempts")),
          initialDelaySeconds: Number(data.get("initialDelaySeconds"))
        }
      })
    });
    setMessage(response.ok ? "已保存工作区默认值，刷新后显示新版本。" :
      response.status === 409 ? "设置已被其他页面更新，请刷新后重试。" : "保存失败，请检查输入。");
  }

  return <form className="tk-panel" aria-label="非敏感工作区设置" onSubmit={save}>
    <p>配置版本 v{settings.version}。{settings.applicationNote}</p>
    <label>默认语言<input name="defaultLocale" defaultValue={settings.defaultLocale} required /></label>
    <label>默认币种<input name="defaultCurrency" defaultValue={settings.defaultCurrency} required /></label>
    <label>Provider 模式<select name="externalAdapterMode" defaultValue={settings.externalAdapterMode}><option value="mock">mock</option><option value="live">live</option></select></label>
    <label>素材目录<input name="assetRoot" defaultValue={settings.assetRoot} required /></label>
    <label>Worker 并发<input name="workerConcurrency" type="number" min="1" max="32" defaultValue={settings.workerConcurrency} required /></label>
    <label>Canvas 每日上限<input name="maxCanvasRunsPerDay" type="number" min="1" defaultValue={settings.maxCanvasRunsPerDay} required /></label>
    <fieldset><legend>定价公式默认值</legend>
      <label>国内运费 CNY<input name="domesticShippingCny" defaultValue={settings.pricingDefaults.domesticShippingCny} required /></label>
      <label>跨境成本 CNY<input name="crossBorderCostCny" defaultValue={settings.pricingDefaults.crossBorderCostCny} required /></label>
      <label>固定成本 THB<input name="fixedTargetCostThb" defaultValue={settings.pricingDefaults.fixedTargetCostThb} required /></label>
      <label>平台费率<input name="platformFeeRate" defaultValue={settings.pricingDefaults.platformFeeRate} required /></label>
      <label>支付费率<input name="paymentFeeRate" defaultValue={settings.pricingDefaults.paymentFeeRate} required /></label>
      <label>目标利润率<input name="targetProfitRate" defaultValue={settings.pricingDefaults.targetProfitRate} required /></label>
      <label>价格尾数<input name="ending" defaultValue={settings.pricingDefaults.ending} required /></label>
    </fieldset>
    <fieldset><legend>非密钥 Provider 默认值</legend>
      <label>Listing Provider<input name="listingProvider" defaultValue={settings.providerOptions.listingProvider} required /></label>
      <label>Listing Model<input name="listingModel" defaultValue={settings.providerOptions.listingModel} required /></label>
      <label>Canvas 工作流<input name="canvasWorkflow" defaultValue={settings.providerOptions.canvasWorkflow} required /></label>
    </fieldset>
    <fieldset><legend>重试策略</legend>
      <label>最多尝试次数<input name="maxAttempts" type="number" min="1" max="20" defaultValue={settings.retryPolicy.maxAttempts} required /></label>
      <label>首次重试等待（秒）<input name="initialDelaySeconds" type="number" min="1" defaultValue={settings.retryPolicy.initialDelaySeconds} required /></label>
    </fieldset>
    <button type="submit">保存非敏感设置</button><output aria-live="polite">{message}</output>
  </form>;
}
