import { externalFailure, type AssetStagingPort } from "@tk/contracts";
import { randomUUID } from "node:crypto";
import { isRetryableHttpStatus } from "../http-status.js";

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
        const multipart = buildMultipartBody({
          fields: { purpose },
          file: { fieldName: "file", fileName: asset.fileName, contentType: asset.contentType, bytes: asset.bytes }
        });
        let response: Response;
        try {
          response = await fetchImpl(config.uploadUrl, {
            method: "POST",
            headers: {
              ...(config.apiKey ? { authorization: `Bearer ${config.apiKey}` } : undefined),
              "content-type": `multipart/form-data; boundary=${multipart.boundary}`,
              "content-length": String(multipart.body.byteLength)
            },
            body: multipart.body.buffer.slice(multipart.body.byteOffset, multipart.body.byteOffset + multipart.body.byteLength) as ArrayBuffer
          });
        } catch {
          throw externalFailure("retryable", "staging.upload_network", "Asset upload is temporarily unavailable");
        }
        if (!response.ok) throw externalFailure(isRetryableHttpStatus(response.status) ? "retryable" : "fatal", `staging.http_${response.status}`, "Asset upload failed");
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

function buildMultipartBody(input: {
  fields: Record<string, string>;
  file: { fieldName: string; fileName: string; contentType: string; bytes: Uint8Array };
}): { boundary: string; body: Uint8Array } {
  const boundary = `----tk-staging-${randomUUID().replace(/-/g, "")}`;
  const encoder = new TextEncoder();
  const chunks: Uint8Array[] = [];
  for (const [name, value] of Object.entries(input.fields)) {
    chunks.push(encoder.encode(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="${escapeDisposition(name)}"\r\n\r\n` +
      `${value}\r\n`
    ));
  }
  chunks.push(encoder.encode(
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="${escapeDisposition(input.file.fieldName)}"; filename="${escapeDisposition(input.file.fileName)}"\r\n` +
    `Content-Type: ${input.file.contentType}\r\n\r\n`
  ));
  chunks.push(input.file.bytes);
  chunks.push(encoder.encode(`\r\n--${boundary}--\r\n`));
  const total = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { boundary, body };
}

function escapeDisposition(value: string): string {
  return value.replace(/["\\\r\n]/g, "_");
}

function extractUploadUrl(raw: unknown, uploadUrl: string): string | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as { url?: unknown; path?: unknown; file?: { url?: unknown; path?: unknown }; files?: Array<{ url?: unknown; path?: unknown }> };
  const candidate = item.url ?? item.path ?? item.file?.url ?? item.file?.path ?? item.files?.[0]?.url ?? item.files?.[0]?.path;
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const trimmed = candidate.trim();
  if (/^\/assets\/(?:input|output)\//.test(trimmed)) {
    const origin = new URL(uploadUrl).origin;
    return isLoopbackOrigin(origin) ? trimmed : new URL(trimmed, origin).toString();
  }
  try {
    const url = new URL(trimmed, uploadUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const hostname = new URL(origin).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    return hostname === "localhost" || hostname === "::1" || /^127\./.test(hostname);
  } catch {
    return false;
  }
}
