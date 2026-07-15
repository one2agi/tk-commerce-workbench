import { externalFailure, type AssetStagingPort } from "@tk/contracts";

export interface ResolvedLocalAsset {
  readonly bytes: Uint8Array;
  readonly fileName: string;
  readonly contentType: "image/png" | "image/jpeg";
}

export interface AssetStagingAdapterConfig {
  readonly uploadUrl: string;
  readonly apiKey?: string;
  readonly ttlMs?: number;
  readonly nowMs?: () => number;
  readonly fetchImpl?: typeof fetch;
  readonly resolveLocalAsset: (localAssetId: string) => Promise<ResolvedLocalAsset>;
  /** Optional real cleanup operation. Without it, release only forgets local tracking. */
  readonly onRelease?: (remoteUrls: string[]) => Promise<void>;
}

export function createAssetStagingAdapter(config: AssetStagingAdapterConfig): AssetStagingPort {
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const tracked = new Set<string>();
  return {
    async stage({ localAssetIds, purpose }) {
      if (localAssetIds.length === 0 || localAssetIds.some((id) => !id.trim()) || new Set(localAssetIds).size !== localAssetIds.length) {
        throw externalFailure("needs_input", "staging.invalid_asset_ids", "Asset staging requires unique non-empty asset identifiers");
      }
      const expiresAt = new Date((config.nowMs?.() ?? Date.now()) + (config.ttlMs ?? 3_600_000)).toISOString();
      const results = [];
      for (const localAssetId of localAssetIds) {
        let asset: ResolvedLocalAsset;
        try { asset = await config.resolveLocalAsset(localAssetId); } catch { throw externalFailure("needs_input", "staging.asset_not_found", "Local asset could not be loaded"); }
        if (asset.bytes.byteLength === 0 || !asset.fileName.trim()) throw externalFailure("needs_input", "staging.asset_not_found", "Local asset could not be loaded");
        const form = new FormData();
        const bytes = asset.bytes.buffer.slice(asset.bytes.byteOffset, asset.bytes.byteOffset + asset.bytes.byteLength) as ArrayBuffer;
        form.append("file", new Blob([bytes], { type: asset.contentType }), asset.fileName);
        form.append("purpose", purpose);
        let response: Response;
        try {
          response = await fetchImpl(config.uploadUrl, { method: "POST", headers: config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined, body: form });
        } catch {
          throw externalFailure("retryable", "staging.upload_network", "Asset upload is temporarily unavailable");
        }
        if (!response.ok) throw externalFailure(response.status >= 500 || response.status === 429 ? "retryable" : "fatal", `staging.http_${response.status}`, "Asset upload failed");
        let raw: unknown;
        try { raw = await response.json(); } catch { throw externalFailure("fatal", "staging.invalid_response", "Asset upload returned invalid data"); }
        const remoteUrl = extractUploadUrl(raw, config.uploadUrl);
        if (!remoteUrl) throw externalFailure("fatal", "staging.missing_remote_url", "Asset upload did not return a public URL");
        tracked.add(remoteUrl);
        results.push(Object.freeze({ remoteUrl, expiresAt }));
      }
      return results;
    },
    async release({ remoteUrls }) {
      const owned = [...new Set(remoteUrls)].filter((url) => tracked.has(url));
      if (owned.length > 0) await config.onRelease?.(owned);
      for (const url of owned) tracked.delete(url);
    }
  };
}

function extractUploadUrl(raw: unknown, uploadUrl: string): string | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { url?: unknown; path?: unknown; file?: { url?: unknown; path?: unknown }; files?: Array<{ url?: unknown; path?: unknown }> };
  const candidate = item.url ?? item.path ?? item.file?.url ?? item.file?.path ?? item.files?.[0]?.url ?? item.files?.[0]?.path;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  try {
    const url = new URL(candidate, uploadUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}
