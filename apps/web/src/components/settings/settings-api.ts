"use client";

import { useCallback, useState } from "react";

import type { WorkspaceSettingsView } from "../../server/services/settings-service";

export type SaveState = "idle" | "saving" | "conflict" | "error";

export type PatchResult =
  | { ok: true; value: WorkspaceSettingsView }
  | { ok: false; status: number; actualVersion?: number };

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
  return response.ok
    ? { ok: true, value: (await response.json()) as WorkspaceSettingsView }
    : { ok: false, status: response.status };
}

// ─── new JSON-path for controlled inputs ───────────────────────────────────
export async function patchSettings(
  fetcher: typeof fetch,
  baseline: WorkspaceSettingsView,
  draft: WorkspaceSettingsView,
  _dirtyFields: ReadonlySet<string>
): Promise<PatchResult> {
  const response = await fetcher("/api/v1/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      expectedVersion: baseline.version,
      defaultLocale: draft.defaultLocale,
      defaultCurrency: draft.defaultCurrency,
      externalAdapterMode: draft.externalAdapterMode,
      assetRoot: draft.assetRoot,
      workerConcurrency: draft.workerConcurrency,
      maxCanvasRunsPerDay: draft.maxCanvasRunsPerDay,
      pricingDefaults: draft.pricingDefaults,
      providerOptions: draft.providerOptions,
      retryPolicy: draft.retryPolicy
    })
  });
  if (response.ok) {
    return { ok: true, value: (await response.json()) as WorkspaceSettingsView };
  }
  let actualVersion: number | undefined;
  if (response.status === 409) {
    try {
      const body = (await response.json()) as { actualVersion?: number };
      actualVersion = body.actualVersion;
    } catch {
      // ignore parse failure
    }
  }
  return { ok: false, status: response.status, actualVersion };
}

// ─── React hook ────────────────────────────────────────────────────────────
export interface UseSaveSettingsOptions {
  fetcher?: typeof fetch;
}

export interface UseSaveSettingsResult {
  state: SaveState;
  error: string | null;
  lastSaved: WorkspaceSettingsView | null;
  save: (baseline: WorkspaceSettingsView, draft: WorkspaceSettingsView, dirtyFields: ReadonlySet<string>) => Promise<void>;
  reset: () => void;
}

export function useSaveSettings(options: UseSaveSettingsOptions = {}): UseSaveSettingsResult {
  const fetcher = options.fetcher ?? fetch;
  const [state, setState] = useState<SaveState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastSaved, setLastSaved] = useState<WorkspaceSettingsView | null>(null);

  const save = useCallback(
    async (baseline: WorkspaceSettingsView, draft: WorkspaceSettingsView, dirtyFields: ReadonlySet<string>) => {
      setState("saving");
      setError(null);
      const result = await patchSettings(fetcher, baseline, draft, dirtyFields);
      if (result.ok) {
        setLastSaved(result.value);
        setState("idle");
        return;
      }
      if (result.status === 409) {
        setState("conflict");
        setError(result.actualVersion !== undefined ? `设置已被更新到版本 v${result.actualVersion}` : "设置已被其他页面更新");
        return;
      }
      setState("error");
      setError("保存失败，请稍后重试");
    },
    [fetcher]
  );

  const reset = useCallback(() => {
    setState("idle");
    setError(null);
  }, []);

  return { state, error, lastSaved, save, reset };
}
