"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { WorkspaceSettingsView } from "../../server/services/settings-service";
import { computeDirtyFields, setNestedField } from "./dirty";
import { SaveBar } from "./save-bar";
import { AdvancedSettingsSection } from "./sections/advanced-settings-section";
import { BasicSettingsSection } from "./sections/basic-settings-section";
import { ProviderOptionsSection } from "./sections/provider-options-section";
import { RetryPolicySection } from "./sections/retry-policy-section";
import { SecretStatusSection } from "./sections/secret-status-section";
import { SystemDiagnosticsSection } from "./sections/system-diagnostics-section";
import { SettingsCard } from "./settings-card";
import { useSaveSettings } from "./settings-api";

export interface SettingsWorkspaceProps {
  initial: WorkspaceSettingsView;
  fetcher?: typeof fetch;
}

type FieldErrors = Readonly<Record<string, string>>;

interface ToastState {
  message: string;
  key: number;
}

const STARTUP_FIELDS = new Set([
  "externalAdapterMode",
  "workerConcurrency",
  "maxCanvasRunsPerDay",
  "assetRoot",
  "providerOptions.imageGenerationPath",
  "providerOptions.imagePlannerModel",
  "providerOptions.imageProviderModel",
  "providerOptions.canvasWorkflow"
]);

export function validateSettingsDraft(draft: WorkspaceSettingsView): FieldErrors {
  const errors: Record<string, string> = {};
  if (draft.providerOptions.imageGenerationPath === "headless") {
    if (!draft.providerOptions.imagePlannerModel.trim()) {
      errors["providerOptions.imagePlannerModel"] = "请输入 Planner 模型 ID";
    }
    if (!draft.providerOptions.imageProviderModel.trim()) {
      errors["providerOptions.imageProviderModel"] = "请输入图片模型 ID";
    }
  } else {
    if (!draft.providerOptions.canvasWorkflow.trim()) {
      errors["providerOptions.canvasWorkflow"] = "请输入 Canvas 工作流名称";
    }
    if (!Number.isInteger(draft.maxCanvasRunsPerDay) || draft.maxCanvasRunsPerDay < 0 || draft.maxCanvasRunsPerDay > 10_000) {
      errors.maxCanvasRunsPerDay = "请输入 0–10000 之间的整数；0 表示不限次数";
    }
  }
  return errors;
}

function focusFirstError(errors: FieldErrors): void {
  const first = Object.keys(errors)[0];
  if (!first) return;
  const id = first.replace("providerOptions.", "");
  document.getElementById(id)?.focus();
}

export function SettingsWorkspace({ initial, fetcher }: SettingsWorkspaceProps): React.JSX.Element {
  const [baseline, setBaseline] = useState<WorkspaceSettingsView>(initial);
  const [draft, setDraft] = useState<WorkspaceSettingsView>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [toast, setToast] = useState<ToastState | null>(null);
  const saveHook = useSaveSettings({ fetcher });

  const dirtyFields = useMemo(() => computeDirtyFields(baseline, draft), [baseline, draft]);
  const dirtyCount = dirtyFields.size;
  const restartRequired = [...dirtyFields].some((field) => STARTUP_FIELDS.has(field));

  const handleFieldChange = useCallback((dottedPath: string, value: unknown) => {
    setDraft((previous) => setNestedField(previous, dottedPath, value));
    setErrors((previous) => {
      if (!previous[dottedPath]) return previous;
      const next = { ...previous };
      delete next[dottedPath];
      return next;
    });
  }, []);

  const handleDiscard = useCallback(() => {
    setDraft(baseline);
    setErrors({});
    saveHook.reset();
    setToast(null);
  }, [baseline, saveHook]);

  const handleSave = useCallback(async () => {
    if (dirtyCount === 0) return;
    const validationErrors = validateSettingsDraft(draft);
    if (Object.keys(validationErrors).length > 0) {
      setErrors(validationErrors);
      focusFirstError(validationErrors);
      return;
    }
    const saved = await saveHook.save(baseline, draft, dirtyFields);
    if (!saved) return;
    setBaseline(saved);
    setDraft(saved);
    setToast({ message: `更改已保存 · 版本 v${saved.version}`, key: Date.now() });
  }, [baseline, draft, dirtyCount, dirtyFields, saveHook]);

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === "s" && dirtyCount > 0 && saveHook.state !== "saving") {
        event.preventDefault();
        void handleSave();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [dirtyCount, saveHook.state, handleSave]);

  useEffect(() => {
    if (dirtyCount === 0) return;
    function onBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirtyCount]);

  const basicDirty = ["defaultLocale", "defaultCurrency", "externalAdapterMode", "workerConcurrency"]
    .filter((field) => dirtyFields.has(field)).length;
  const generationDirty = ["imageGenerationPath", "imagePlannerModel", "imageProviderModel", "canvasWorkflow"]
    .filter((field) => dirtyFields.has(`providerOptions.${field}`)).length + (dirtyFields.has("maxCanvasRunsPerDay") ? 1 : 0);
  const retryDirty = ["maxAttempts", "initialDelaySeconds"]
    .filter((field) => dirtyFields.has(`retryPolicy.${field}`)).length;

  return (
    <div className="tk-settings-shell">
      <aside className="tk-settings-sidebar">
        <div className="tk-settings-sidebar__title">
          <span>工作区</span>
          <strong>设置</strong>
        </div>
        <nav aria-label="设置分区">
          <a href="#basic">基础设置</a>
          <a href="#generation">生图与模型</a>
          <a href="#reliability">稳定性</a>
          <a href="#services">服务状态</a>
          <a href="#advanced">高级设置</a>
        </nav>
        <div className="tk-settings-sidebar__runtime">
          <span className={draft.externalAdapterMode === "live" ? "is-live" : "is-test"}>
            {draft.externalAdapterMode === "live" ? "生产模式" : "测试模式"}
          </span>
          <p>配置版本 v{baseline.version}</p>
        </div>
      </aside>

      <main className="tk-settings-content">
        <header className="tk-settings-header">
          <div>
            <p>WORKSPACE CONFIGURATION</p>
            <h1>设置</h1>
            <span>配置商品处理默认值、图片生成路径和 Worker 稳定性。</span>
          </div>
          <div className="tk-settings-header__boundary">
            <strong>保存不会重启 Worker</strong>
            <span>启动型更改需同步服务器配置并重启后生效。</span>
          </div>
        </header>

        <div id="basic"><SettingsCard title="基础设置" hint="工作区默认语言、币种和处理能力" ariaLabel="基础设置" dirtyCount={basicDirty}>
          <BasicSettingsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
        </SettingsCard></div>

        <div id="generation"><SettingsCard title="生图与模型" hint="选择 Headless API 或保留 Canvas 兼容路径" ariaLabel="生图与模型" dirtyCount={generationDirty}>
          <ProviderOptionsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} errors={errors} />
        </SettingsCard></div>

        <div id="reliability"><SettingsCard title="稳定性" hint="外部服务暂时不可用时的重试策略" ariaLabel="稳定性" dirtyCount={retryDirty}>
          <RetryPolicySection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
        </SettingsCard></div>

        <div id="services"><SettingsCard title="服务状态" hint="仅显示安全的就绪状态与 Worker 当前运行值" ariaLabel="服务状态">
          <SecretStatusSection draft={draft} />
          <SystemDiagnosticsSection draft={draft} />
        </SettingsCard></div>

        <div id="advanced"><AdvancedSettingsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} /></div>
      </main>

      <SaveBar state={saveHook.state} error={saveHook.error} dirtyCount={dirtyCount} version={baseline.version} restartRequired={restartRequired} onDiscard={handleDiscard} onSave={() => void handleSave()} />

      {toast ? <output className="tk-toast" role="status" key={toast.key}><span aria-hidden>✓</span>{toast.message}</output> : null}
    </div>
  );
}
