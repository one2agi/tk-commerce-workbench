"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import type { SecretFieldName } from "../../../../../packages/contracts/src/runtime-configuration.js";
import type { WorkspaceSettingsView } from "../../server/services/settings-service";
import { computeDirtyFields, setNestedField } from "./dirty";
import { SaveBar } from "./save-bar";
import type { SecretDraft, SecretDraftMap } from "./secret-field";
import { AdvancedSettingsSection } from "./sections/advanced-settings-section";
import { BasicSettingsSection } from "./sections/basic-settings-section";
import { ExternalServicesSection } from "./sections/external-services-section";
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
interface ToastState { message: string; key: number; }

const RUNTIME_STATUS_POLL_MS = 1_500;

export function validateSettingsDraft(draft: WorkspaceSettingsView): FieldErrors {
  const errors: Record<string, string> = {};
  const config = draft.serviceConfiguration;
  if (draft.providerOptions.imageGenerationPath === "headless") {
    if (draft.externalAdapterMode === "live" && !config?.imagePlannerBaseUrl.trim()) errors["serviceConfiguration.imagePlannerBaseUrl"] = "请输入 Planner API 地址";
    if (!config?.imagePlannerModel.trim()) errors["serviceConfiguration.imagePlannerModel"] = "请输入 Planner 模型 ID";
    if (draft.externalAdapterMode === "live" && !config?.imageProviderBaseUrl.trim()) errors["serviceConfiguration.imageProviderBaseUrl"] = "请输入图片 API 地址";
    if (!config?.imageProviderModel.trim()) errors["serviceConfiguration.imageProviderModel"] = "请输入图片模型 ID";
  } else {
    if (!config?.canvasWorkflowName.trim()) errors["serviceConfiguration.canvasWorkflowName"] = "请输入 Canvas 工作流名称";
    if (!Number.isInteger(draft.maxCanvasRunsPerDay) || draft.maxCanvasRunsPerDay < 0 || draft.maxCanvasRunsPerDay > 10_000) {
      errors.maxCanvasRunsPerDay = "请输入 0–10000 之间的整数；0 表示不限次数";
    }
  }
  return errors;
}

function focusFirstError(errors: FieldErrors): void {
  const first = Object.keys(errors)[0];
  if (!first) return;
  const id = first.startsWith("serviceConfiguration.")
    ? `service-${first.replace("serviceConfiguration.", "")}`
    : first.replace("providerOptions.", "");
  document.getElementById(id)?.focus();
}

export function SettingsWorkspace({ initial, fetcher }: SettingsWorkspaceProps): React.JSX.Element {
  const normalizedInitial = useMemo(() => normalizeSettingsView(initial), [initial]);
  const [baseline, setBaseline] = useState<WorkspaceSettingsView>(normalizedInitial);
  const [draft, setDraft] = useState<WorkspaceSettingsView>(normalizedInitial);
  const [secretDrafts, setSecretDrafts] = useState<SecretDraftMap>({});
  const [errors, setErrors] = useState<FieldErrors>({});
  const [toast, setToast] = useState<ToastState | null>(null);
  const [runtimePollingVersion, setRuntimePollingVersion] = useState<number | null>(null);
  const saveHook = useSaveSettings({ fetcher });

  const dirtyFields = useMemo(() => {
    const fields = new Set(computeDirtyFields(baseline, draft));
    for (const [field, value] of Object.entries(secretDrafts)) {
      if (value?.clear || value?.value.trim()) fields.add(`secret.${field}`);
    }
    return fields;
  }, [baseline, draft, secretDrafts]);
  const dirtyCount = dirtyFields.size;

  const handleFieldChange = useCallback((dottedPath: string, value: unknown) => {
    setDraft((previous) => setNestedField(previous, dottedPath, value));
    setErrors((previous) => {
      if (!previous[dottedPath]) return previous;
      const next = { ...previous };
      delete next[dottedPath];
      return next;
    });
  }, []);

  const handleSecretChange = useCallback((field: SecretFieldName, value: SecretDraft) => {
    setSecretDrafts((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleDiscard = useCallback(() => {
    setDraft(baseline);
    setSecretDrafts({});
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
    const saved = await saveHook.save(baseline, draft, dirtyFields, secretDrafts);
    if (!saved) return;
    const normalizedSaved = normalizeSettingsView(saved);
    setBaseline(normalizedSaved);
    setDraft(normalizedSaved);
    setSecretDrafts({});
    setRuntimePollingVersion(isRuntimeStatusTerminal(normalizedSaved.runtimeStatus, saved.version) ? null : saved.version);
    setToast({ message: `更改已保存 · 版本 v${saved.version}`, key: Date.now() });
  }, [baseline, draft, dirtyCount, dirtyFields, saveHook, secretDrafts]);

  useEffect(() => {
    if (runtimePollingVersion === null) return;
    const pollingFetcher = fetcher ?? fetch;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;

    const schedule = () => {
      if (!cancelled) timer = setTimeout(() => void poll(), RUNTIME_STATUS_POLL_MS);
    };
    const poll = async () => {
      controller = new AbortController();
      try {
        const response = await pollingFetcher("/api/v1/settings", {
          method: "GET",
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: controller.signal
        });
        if (!response.ok) {
          schedule();
          return;
        }
        const refreshed = normalizeSettingsView(await response.json() as WorkspaceSettingsView);
        if (cancelled) return;
        const runtimeStatus = refreshed.runtimeStatus;
        setBaseline((previous) => ({ ...previous, runtimeStatus }));
        setDraft((previous) => ({ ...previous, runtimeStatus }));
        if (isRuntimeStatusTerminal(runtimeStatus, runtimePollingVersion)) {
          setRuntimePollingVersion(null);
          return;
        }
        schedule();
      } catch (error) {
        if (!cancelled && !(error instanceof DOMException && error.name === "AbortError")) schedule();
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      controller?.abort();
    };
  }, [fetcher, runtimePollingVersion]);

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
  const generationDirty = Number(dirtyFields.has("providerOptions.imageGenerationPath")) + Number(dirtyFields.has("maxCanvasRunsPerDay"));
  const retryDirty = ["maxAttempts", "initialDelaySeconds"].filter((field) => dirtyFields.has(`retryPolicy.${field}`)).length;
  const servicesDirty = [...dirtyFields].filter((field) => field.startsWith("serviceConfiguration.") || field.startsWith("secret.")).length;

  return (
    <div className="tk-settings-shell">
      <aside className="tk-settings-sidebar">
        <div className="tk-settings-sidebar__title"><span>工作区</span><strong>设置</strong></div>
        <nav aria-label="设置分区">
          <a href="#basic">基础设置</a>
          <a href="#generation">生图路径</a>
          <a href="#external-services">外部服务</a>
          <a href="#reliability">稳定性</a>
          <a href="#services">应用状态</a>
          <a href="#advanced">高级设置</a>
        </nav>
        <div className="tk-settings-sidebar__runtime">
          <span className={draft.externalAdapterMode === "live" ? "is-live" : "is-test"}>{draft.externalAdapterMode === "live" ? "生产模式" : "测试模式"}</span>
          <p>已保存 v{baseline.version} · {baseline.runtimeStatus.applyState === "applied" ? `已应用 v${baseline.runtimeStatus.appliedVersion ?? "-"}` : "等待 Worker 应用"}</p>
        </div>
      </aside>

      <main className="tk-settings-content">
        <header className="tk-settings-header">
          <div><p>WORKSPACE CONFIGURATION</p><h1>设置</h1><span>集中维护工作区、模型和外部服务配置。</span></div>
          <div className="tk-settings-header__boundary is-auto-apply"><strong>保存后自动生效</strong><span>Worker 会在当前任务结束后应用有效的新版本。</span></div>
        </header>

        <div id="basic"><SettingsCard title="基础设置" hint="默认语言、币种和处理能力" ariaLabel="基础设置" dirtyCount={basicDirty}>
          <BasicSettingsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
        </SettingsCard></div>

        <div id="generation"><SettingsCard title="生图路径" hint="选择 Headless API 或保留 Canvas 兼容路径" ariaLabel="生图路径" dirtyCount={generationDirty}>
          <ProviderOptionsSection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} errors={errors} />
        </SettingsCard></div>

        <div id="external-services"><SettingsCard title="外部服务" hint="地址、模型与密钥统一在这里维护" ariaLabel="外部服务" dirtyCount={servicesDirty}>
          <ExternalServicesSection draft={draft} dirtyFields={dirtyFields} secretDrafts={secretDrafts} errors={errors} onFieldChange={handleFieldChange} onSecretChange={handleSecretChange} />
        </SettingsCard></div>

        <div id="reliability"><SettingsCard title="稳定性" hint="外部服务暂时不可用时的重试策略" ariaLabel="稳定性" dirtyCount={retryDirty}>
          <RetryPolicySection draft={draft} dirtyFields={dirtyFields} onFieldChange={handleFieldChange} />
        </SettingsCard></div>

        <div id="services"><SettingsCard title="应用状态" hint="安全状态与 Worker 已应用版本" ariaLabel="应用状态">
          <SecretStatusSection draft={draft} />
          <SystemDiagnosticsSection draft={draft} />
        </SettingsCard></div>

        <div id="advanced"><AdvancedSettingsSection draft={draft} /></div>
      </main>

      <SaveBar state={saveHook.state} error={saveHook.error} dirtyCount={dirtyCount} version={baseline.version} onDiscard={handleDiscard} onSave={() => void handleSave()} />
      {toast ? <output className="tk-toast" role="status" key={toast.key}><span aria-hidden>✓</span>{toast.message}</output> : null}
    </div>
  );
}

function isRuntimeStatusTerminal(
  status: WorkspaceSettingsView["runtimeStatus"],
  savedVersion: number
): boolean {
  if (status.applyState === "error") {
    return status.candidateVersion !== null &&
      status.candidateVersion !== undefined &&
      status.candidateVersion >= savedVersion;
  }
  return status.applyState === "applied" &&
    status.appliedVersion !== null &&
    status.appliedVersion !== undefined &&
    status.appliedVersion >= savedVersion;
}

function normalizeSettingsView(view: WorkspaceSettingsView): WorkspaceSettingsView {
  if (view.serviceConfiguration) return view;
  return {
    ...view,
    serviceConfiguration: {
      imageGenerationPath: view.providerOptions.imageGenerationPath,
      imagePlannerBaseUrl: "", imagePlannerModel: view.providerOptions.imagePlannerModel,
      imageProviderBaseUrl: "", imageProviderModel: view.providerOptions.imageProviderModel,
      canvasBaseUrl: "", canvasId: "", canvasWorkflowName: view.providerOptions.canvasWorkflow,
      llmBaseUrl: "", llmModel: view.providerOptions.listingModel, exchangeRateBaseUrl: "",
      miaoshouBaseUrl: "", miaoshouAccountId: "", assetPublishS3Endpoint: "",
      assetPublishS3Region: "", assetPublishS3Bucket: "", assetPublishPublicBaseUrl: ""
    }
  };
}
