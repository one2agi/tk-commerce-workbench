// Miaoshou HTTP client. Signs every request with HMAC-SHA256 of the canonical
// params + body, reads credentials from the adapter config (which itself pulls
// them from @tk/config — never logged). The signing key is the app secret.
//
// NEVER log or echo the secret into errors, fixtures, or console output.

import { createHmac } from "node:crypto";
import { isRetryableHttpStatus } from "../http-status.js";

export const MIAOSHOU_DEFAULT_BASE_URL = "https://openapi-erp.91miaoshou.com";

export interface MiaoshouConfig {
  readonly baseUrl: string;
  readonly appKey: string;
  readonly appSecret: string;
  readonly accountId?: string;
  readonly authorization?: string;
  readonly cookie?: string;
}

export interface MiaoshouRequest {
  readonly path: string;
  readonly body: unknown;
}

export interface MiaoshouSignedHeaders {
  readonly "x-app-key": string;
  readonly "x-sign": string;
  readonly "x-timestamp": string;
  readonly "content-type": "application/json";
}

export interface MiaoshouClient {
  sign(req: MiaoshouRequest, timestamp?: number): MiaoshouSignedHeaders;
  signSerialized(path: string, bodyJson: string, timestamp?: number): MiaoshouSignedHeaders;
  buildUrl(path: string): string;
}

export function createMiaoshouClient(config: MiaoshouConfig): MiaoshouClient {
  return {
    buildUrl(path) {
      const base = config.baseUrl.replace(/\/+$/, "");
      const p = path.replace(/^\/+/, "");
      return `${base}/${p}`;
    },
    sign(req, timestamp = Math.floor(Date.now() / 1_000)) {
      return this.signSerialized(req.path, JSON.stringify(req.body ?? {}), timestamp);
    },
    signSerialized(path, payload, timestamp = Math.floor(Date.now() / 1_000)) {
      const ts = String(timestamp);
      const canonical =
        config.appSecret +
        path +
        ts +
        config.appKey +
        payload +
        config.appSecret;
      const sig = createHmac("sha256", config.appSecret)
        .update(canonical)
        .digest("hex");
      return Object.freeze({
        "x-app-key": config.appKey,
        "x-sign": sig,
        "x-timestamp": ts,
        "content-type": "application/json"
      });
    }
  };
}

export interface MiaoshouHttp {
  post<T>(path: string, body: unknown): Promise<T>;
}

export function createMiaoshouHttp(
  config: MiaoshouConfig,
  fetchImpl: typeof fetch = globalThis.fetch,
  nowSeconds: () => number = () => Math.floor(Date.now() / 1_000)
): MiaoshouHttp {
  const client = createMiaoshouClient(config);
  return {
    async post<T>(path: string, body: unknown): Promise<T> {
      const bodyJson = JSON.stringify(body ?? {});
      const signed = client.signSerialized(path, bodyJson, nowSeconds());
      const headers: Record<string, string> = { ...signed };
      if (config.accountId) headers["x-account-id"] = config.accountId;
      if (config.authorization) headers.authorization = config.authorization;
      if (config.cookie) headers.cookie = config.cookie;
      let response: Response;
      try {
        response = await fetchImpl(client.buildUrl(path), { method: "POST", headers, body: bodyJson });
      } catch {
        throw Object.freeze({ kind: "retryable", code: "miaoshou.network", safeMessage: "Miaoshou API is temporarily unavailable" });
      }
      if (!response.ok) {
        throw Object.freeze({
          kind: isRetryableHttpStatus(response.status) ? "retryable" : "fatal",
          code: `miaoshou.http_${response.status}`,
          safeMessage: "Miaoshou API request failed"
        });
      }
      try {
        return await response.json() as T;
      } catch {
        throw Object.freeze({ kind: "retryable", code: "miaoshou.invalid_response", safeMessage: "Miaoshou API returned an invalid response" });
      }
    }
  };
}

export function createMiaoshouSourceHttp(config: MiaoshouConfig, fetchImpl?: typeof fetch): MiaoshouHttp {
  return createMiaoshouHttp(config, fetchImpl);
}
