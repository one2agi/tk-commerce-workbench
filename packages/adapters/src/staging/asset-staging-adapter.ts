import { externalFailure, type AssetStagingPort } from "@tk/contracts";

export interface AssetStagingAdapterConfig {
  readonly publicBaseUrl: string;
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
  readonly onRelease?: (remoteUrls: string[]) => Promise<void>;
}

export function createAssetStagingAdapter(config: AssetStagingAdapterConfig): AssetStagingPort {
  const base = config.publicBaseUrl.replace(/\/+$/, "");
  return {
    async stage({ localAssetIds, purpose }) {
      if (localAssetIds.length === 0 || localAssetIds.some((id) => !id.trim()) || new Set(localAssetIds).size !== localAssetIds.length) {
        throw externalFailure("needs_input", "staging.invalid_asset_ids", "Asset staging requires unique non-empty asset identifiers");
      }
      const expiresAt = new Date((config.nowMs?.() ?? Date.now()) + (config.ttlMs ?? 3_600_000)).toISOString();
      return localAssetIds.map((id) => Object.freeze({ remoteUrl: `${base}/${encodeURIComponent(id)}?purpose=${purpose}`, expiresAt }));
    },
    async release({ remoteUrls }) {
      await config.onRelease?.([...remoteUrls]);
    }
  };
}
