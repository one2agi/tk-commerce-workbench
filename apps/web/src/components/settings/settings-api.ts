"use client";

import { useCallback, useState } from "react";

import type { WorkspaceSettingsView } from "../../server/services/settings-service";
import type { SecretFieldName, SecretMutation } from "../../../../../packages/contracts/src/runtime-configuration.js";
import type { SecretDraftMap } from "./secret-field";

export type SaveState = "idle" | "saving" | "conflict" | "error";

export type PatchResult =
  | { ok: true; value: WorkspaceSettingsView }
  | { ok: false; status: number; actualVersion?: number; errorCode?: string; field?: string };

// ─── legacy FormData path (kept for ops-editors test compatibility) ────────
export async function saveSettings(
  fetcher: typeof fetch,
  current: WorkspaceSettingsView,
  data: FormData
): Promise<{ ok: true; value: WorkspaceSettingsView } | { ok: false; status: number }> {
  const response = await fetcher("/api/v1/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: current.version,
      defaultLocale: data.get("defaultLocale"),
      defaultCurrency: data.get("defaultCurrency"),
      externalAdapterMode: data.get("externalAdapterMode"),
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
        canvasWorkflow: data.get("canvasWorkflow"),
        imageGenerationPath: data.get("imageGenerationPath"),
        imagePlannerModel: data.get("imagePlannerModel"),
        imageProviderModel: data.get("imageProviderModel")
      },
      retryPolicy: {
        maxAttempts: Number(data.get("maxAttempts")),
        initialDelaySeconds: Number(data.get("initialDelaySeconds"))
      }
    })
  });
  return response.ok
    ? { ok: true, value: (await response.json()) as WorkspaceSettingsView }
    : { ok: false, status: response.status };
}

// ─── new JSON-path for controlled inputs ───────────────────────────────────
export async function patchSettings(
  fetcher: typeof fetch,
  baseline: WorkspaceSettingsView,
  draft: WorkspaceSettingsView,
  _dirtyFields: ReadonlySet<string>,
  secretDrafts: SecretDraftMap = {}
): Promise<PatchResult> {
  const secretMutations: Partial<Record<SecretFieldName, SecretMutation>> = {};
  for (const [rawField, secretDraft] of Object.entries(secretDrafts)) {
    if (!secretDraft) continue;
    const field = rawField as SecretFieldName;
    if (secretDraft.clear) {
      secretMutations[field] = { action: "clear" };
      continue;
    }
    const value = secretDraft.value.trim();
    if (value) secretMutations[field] = { action: "replace", value };
  }
  const response = await fetcher("/api/v1/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: baseline.version,
      defaultLocale: draft.defaultLocale,
      defaultCurrency: draft.defaultCurrency,
      externalAdapterMode: draft.externalAdapterMode,
      workerConcurrency: draft.workerConcurrency,
      maxCanvasRunsPerDay: draft.maxCanvasRunsPerDay,
      pricingDefaults: draft.pricingDefaults,
      providerOptions: draft.providerOptions,
      retryPolicy: draft.retryPolicy,
      serviceConfiguration: draft.serviceConfiguration,
      secretMutations: Object.keys(secretMutations).length ? secretMutations : undefined
    })
  });
  if (response.ok) {
    return { ok: true, value: (await response.json()) as WorkspaceSettingsView };
  }
  let details: { actualVersion?: number; error?: string; field?: string } = {};
  try {
    details = await response.json() as typeof details;
  } catch {
    // A proxy may return a non-JSON error page. Keep the user-facing fallback safe.
  }
  return {
    ok: false,
    status: response.status,
    actualVersion: details.actualVersion,
    errorCode: details.error,
    field: details.field
  };
}

// ─── React hook ────────────────────────────────────────────────────────────
export interface UseSaveSettingsOptions {
  fetcher?: typeof fetch;
}

export interface UseSaveSettingsResult {
  state: SaveState;
  error: string | null;
  lastSaved: WorkspaceSettingsView | null;
  save: (baseline: WorkspaceSettingsView, draft: WorkspaceSettingsView, dirtyFields: ReadonlySet<string>, secretDrafts?: SecretDraftMap) => Promise<WorkspaceSettingsView | null>;
  reset: () => void;
}

export function useSaveSettings(options: UseSaveSettingsOptions = {}): UseSaveSettingsResult {
  const fetcher = options.fetcher ?? fetch;
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<WorkspaceSettingsView | null>(null);

  const save = useCallback(
    async (baseline: WorkspaceSettingsView, draft: WorkspaceSettingsView, dirtyFields: ReadonlySet<string>, secretDrafts: SecretDraftMap = {}) => {
      setState("saving");
      setError(null);
      const result = await patchSettings(fetcher, baseline, draft, dirtyFields, secretDrafts);
      if (result.ok) {
        setLastSaved(result.value);
        setState("idle");
        return result.value;
      }
      if (result.status === 409) {
        setState("conflict");
        setError(result.actualVersion !== undefined
          ? `另一页面已保存版本 v${result.actualVersion}。请重新加载页面，再应用本次更改。`
          : "另一页面已更新设置。请重新加载页面，再应用本次更改。");
        return null;
      }
      if (result.status === 400) {
        setState("error");
        setError(result.field
          ? `配置未保存。请检查“${fieldLabel(result.field)}”后再次保存。`
          : "配置未保存。请检查必填的服务地址、模型和密钥。");
        return null;
      }
      setState("error");
      setError("设置未保存。请检查网络连接后再次保存。");
      return null;
    },
    [fetcher]
  );

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
  }, []);

  return { state, error, lastSaved, save, reset };
}

function fieldLabel(field: string): string {
  const labels: Record<string, string> = {
    imagePlannerBaseUrl: "Planner API 地址", imagePlannerModel: "Planner 模型",
    imagePlannerApiKey: "Planner API Key", imageProviderBaseUrl: "图片 API 地址",
    imageProviderModel: "图片模型", imageProviderApiKey: "图片 API Key",
    canvasWorkflowName: "Canvas 工作流", extensionToken: "扩展访问 Token"
  };
  return labels[field] ?? field;
}
