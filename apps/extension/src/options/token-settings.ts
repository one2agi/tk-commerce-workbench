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
    }
  };
}
