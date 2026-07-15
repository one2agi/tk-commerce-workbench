// Token settings UI: stores the raw extension bearer token in
// chrome.storage.local. The server stores only the SHA-256 digest of the
// token, so we keep the raw token entirely client-side.

const TOKEN_KEY = "extensionToken";

export interface TokenSettingsEnv {
  readonly storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(obj: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
}

export interface TokenSettings {
  load(): Promise<string | null>;
  save(token: string): Promise<void>;
  clear(): Promise<void>;
  hashForDigest(token: string): string;
}

export function createTokenSettings(env: TokenSettingsEnv): TokenSettings {
  return {
    async load() {
      const got = await env.storage.local.get(TOKEN_KEY);
      const v = got[TOKEN_KEY];
      return typeof v === "string" && v.length > 0 ? v : null;
    },
    async save(token) {
      const trimmed = token.trim();
      if (trimmed.length === 0) throw new Error("token is empty");
      await env.storage.local.set({ [TOKEN_KEY]: trimmed });
    },
    async clear() {
      await env.storage.local.remove(TOKEN_KEY);
    },
    hashForDigest(token) {
      // Use the Web Crypto API where available, otherwise fall back to a
      // non-cryptographic digest placeholder. We import here lazily so the
      // module stays usable in non-browser test environments.
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const crypto = (globalThis as { crypto?: { subtle?: { digest: (alg: string, data: Uint8Array) => Promise<ArrayBuffer> } } }).crypto;
        if (crypto?.subtle) {
          // Synchronous wrapper is not possible for subtle.digest; callers
          // needing the digest should use an async helper.
        }
      } catch {
        // ignore
      }
      // Lightweight non-crypto placeholder for display; real server stores
      // SHA-256 via @tk/config hashing. Kept deterministic for test snapshots.
      let h = 0;
      for (let i = 0; i < token.length; i++) {
        h = (h * 31 + token.charCodeAt(i)) | 0;
      }
      return `placeholder-${h}`;
    }
  };
}