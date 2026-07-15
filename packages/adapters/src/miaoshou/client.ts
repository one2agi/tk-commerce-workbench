// Miaoshou HTTP client. Signs every request with HMAC-SHA256 of the canonical
// params + body, reads credentials from the adapter config (which itself pulls
// them from @tk/config — never logged). The signing key is the app secret.
//
// NEVER log or echo the secret into errors, fixtures, or console output.

import { createHmac } from "node:crypto";

export const MIAOSHOU_DEFAULT_BASE_URL = "https://openapi-erp.91miaoshou.com";

export interface MiaoshouConfig {
  readonly baseUrl: string;
  readonly appKey: string;
  readonly appSecret: string;
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
      const ts = String(timestamp);
      const payload = JSON.stringify(req.body ?? {});
      const canonical =
        config.appSecret +
        req.path +
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
