import type { WorkspaceSettingsView } from "../../server/services/settings-service";

export function setNestedField<T>(obj: T, dottedPath: string, value: unknown): T {
  const keys = dottedPath.split(".");
  const clone = structuredClone(obj) as Record<string, unknown>;
  let cursor: Record<string, unknown> = clone;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    cursor[key] = { ...(cursor[key] as Record<string, unknown>) };
    cursor = cursor[key] as Record<string, unknown>;
  }
  cursor[keys[keys.length - 1]] = value;
  return clone as T;
}

type ScalarKey = "defaultLocale" | "defaultCurrency" | "externalAdapterMode" | "assetRoot" | "workerConcurrency" | "maxCanvasRunsPerDay";

const SCALAR_KEYS: ReadonlyArray<ScalarKey> = [
  "defaultLocale",
  "defaultCurrency",
  "externalAdapterMode",
  "assetRoot",
  "workerConcurrency",
  "maxCanvasRunsPerDay"
];

const NESTED_GROUPS: ReadonlyArray<"pricingDefaults" | "providerOptions" | "retryPolicy"> = [
  "pricingDefaults",
  "providerOptions",
  "retryPolicy"
];

export function computeDirtyFields(
  baseline: WorkspaceSettingsView,
  draft: WorkspaceSettingsView
): ReadonlySet<string> {
  const dirty = new Set<string>();
  for (const key of SCALAR_KEYS) {
    if (baseline[key] !== draft[key]) dirty.add(key);
  }
  for (const group of NESTED_GROUPS) {
    const baseGroup = baseline[group] as Record<string, unknown>;
    const draftGroup = draft[group] as Record<string, unknown>;
    for (const subKey of Object.keys(baseGroup)) {
      if (baseGroup[subKey] !== draftGroup[subKey]) {
        dirty.add(`${group}.${subKey}`);
      }
    }
  }
  return dirty;
}
