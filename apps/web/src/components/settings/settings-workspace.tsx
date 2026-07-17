"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { WorkspaceSettingsView } from "../../server/services/settings-service";
import { computeDirtyFields, setNestedField } from "./dirty";
import { InfoBanner } from "./info-banner";
import { SaveBar } from "./save-bar";
import { BasicSettingsSection } from "./sections/basic-settings-section";
import { PricingFormulaSection } from "./sections/pricing-formula-section";
import { ProviderOptionsSection } from "./sections/provider-options-section";
import { RetryPolicySection } from "./sections/retry-policy-section";
import { SecretStatusSection } from "./sections/secret-status-section";
import { SettingsCard } from "./settings-card";
import { useSaveSettings, type SaveState } from "./settings-api";

export interface SettingsWorkspaceProps {
  initial: WorkspaceSettingsView;
  fetcher?: typeof fetch;
}

interface ToastState {
  kind: "success" | "error";
  message: string;
  key: number;
}

export function SettingsWorkspace({ initial, fetcher }: SettingsWorkspaceProps): React.JSX.Element {
  const [baseline, setBaseline] = useState<WorkspaceSettingsView>(initial);
  const [draft, setDraft] = useState<WorkspaceSettingsView>(initial);
  const [toast, setToast] = useState<ToastState | null>(null);
  const saveHook = useSaveSettings({ fetcher });
  const prevSaveStateRef = useRef<SaveState>("idle");

  const dirtyFields = useMemo(() => computeDirtyFields(baseline, draft), [baseline, draft]);
  const dirtyCount = dirtyFields.size;

  const handleFieldChange = useCallback((dottedPath: string, value: unknown) => {
    setDraft((prev: WorkspaceSettingsView) => setNestedField(prev, dottedPath, value));
  }, []);

  const handleDiscard = useCallback(() => {
    setDraft(baseline);
    saveHook.reset();
    setToast(null);
  }, [baseline, saveHook]);

  const handleSave = useCallback(async () => {
    if (dirtyCount === 0) return;
    await saveHook.save(baseline, draft, dirtyFields);
  }, [baseline, draft, dirtyCount, dirtyFields, saveHook]);

  // Detect successful save (saving → idle with no error) and advance baseline + show toast.
  useEffect(() => {
    if (prevSaveStateRef.current === "saving" && saveHook.state === "idle" && saveHook.error === null) {
      setBaseline(draft);
      setToast({ kind: "success", message: `已保存 · 版本 v${draft.version}`, key: Date.now() });
    }
    prevSaveStateRef.current = saveHook.state;
  }, [saveHook.state, saveHook.error, draft]);

  // Auto-dismiss toast after 5s
  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  // ⌘/Ctrl+S to save
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key === "s" && dirtyCount > 0 && saveHook.state !== "saving") {
        e.preventDefault();
        void handleSave();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dirtyCount, saveHook.state, handleSave]);

  // beforeunload guard when dirty
  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  // Per-card dirty counts
  const basicDirty = ["defaultLocale", "defaultCurrency", "externalAdapterMode", "workerConcurrency", "maxCanvasRunsPerDay", "assetRoot"]
    .filter((k) => dirtyFields.has(k)).length;
  const pricingDirty = ["domesticShippingCny", "crossBorderCostCny", "fixedTargetCostThb", "platformFeeRate", "paymentFeeRate", "targetProfitRate", "ending"]
    .filter((k) => dirtyFields.has(`pricingDefaults.${k}`)).length;
  const providerDirty = ["listingProvider", "listingModel", "canvasWorkflow"]
    .filter((k) => dirtyFields.has(`providerOptions.${k}`)).length;
  const retryDirty = ["maxAttempts", "initialDelaySeconds"]
    .filter((k) => dirtyFields.has(`retryPolicy.${k}`)).length;

  return (
    <>
      <InfoBanner />

      <SettingsCard title="基础设置" hint="新建商品和 Worker 启动时使用的默认值" ariaLabel="基础设置" dirtyCount={basicDirty}>
        <BasicSettingsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="定价公式" hint="影响每个商品的售价建议" ariaLabel="定价公式" dirtyCount={pricingDirty}>
        <PricingFormulaSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="Provider 默认值" hint="非密钥 Provider 的默认配置" ariaLabel="Provider 默认值" dirtyCount={providerDirty}>
        <ProviderOptionsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="重试策略" hint="妙手 / Canvas / LLM 暂时不可用时的行为" ariaLabel="重试策略" dirtyCount={retryDirty}>
        <RetryPolicySection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
      </SettingsCard>

      <SettingsCard title="密钥配置状态" hint="密钥不会进入浏览器或保存到本页面" ariaLabel="密钥配置状态">
        <SecretStatusSection draft={draft} />
      </SettingsCard>

      <SaveBar
        state={saveHook.state}
        error={saveHook.error}
        dirtyCount={dirtyCount}
        version={baseline.version}
        onDiscard={handleDiscard}
        onSave={() => void handleSave()}
      />

      {toast ? (
        <output className="tk-toast" role="status" key={toast.key}>
          <span aria-hidden>✓</span>
          {toast.message}
        </output>
      ) : null}
    </>
  );
}
