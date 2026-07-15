// Miaoshou HTTP client. Signs every request with HMAC-SHA256 of the canonical
// params + body, reads credentials from the adapter config (which itself pulls
// them from @tk/config — never logged). The signing key is the app secret.
//
// NEVER log or echo the secret into errors, fixtures, or console output.

import { createHmac } from "node:crypto";

export interface MiaoshouConfig {
  readonly baseUrl: string; // e.g. https://open.api.miaoshou.com
  readonly appKey: string;
  readonly appSecret: string;
}

export interface MiaoshouRequest {
  readonly path: string;
  readonly body: unknown;
}

export interface MiaoshouSignedHeaders {
  readonly "X-App-Key": string;
  readonly "X-Signature": string;
  readonly "X-Timestamp": string;
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
    sign(req, timestamp = Date.now()) {
      const ts = String(timestamp);
      const payload = JSON.stringify(req.body ?? {});
      // Canonical: METHOD\nPATH\nTIMESTAMP\nBODY_SHA256_HEX
      const bodyHash = createHmac("sha256", "")
        .update(payload)
        .digest("hex");
      const canonical = `POST\n${req.path}\n${ts}\n${bodyHash}`;
      const sig = createHmac("sha256", config.appSecret)
        .update(canonical)
        .digest("hex");
      return Object.freeze({
        "X-App-Key": config.appKey,
        "X-Signature": sig,
        "X-Timestamp": ts,
        "content-type": "application/json"
      });
    }
  };
}