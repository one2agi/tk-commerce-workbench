// Background service-worker submitter: posts the selected-only batch to the
// loopback Ingest Links API with one idempotency key per product, attaching
// the Bearer token from chrome.storage.local. On loopback API failure the
// batch is PAUSED (never silently dropped).

import type { LocalDetailCapture } from "../content/detail-parser.js";

export interface SubmitterEnv {
  readonly apiBase: string; // e.g. http://127.0.0.1:8787
  readonly storage: {
    local: {
      get(key: string): Promise<Record<string, unknown>>;
      set(obj: Record<string, unknown>): Promise<void>;
      remove(key: string): Promise<void>;
    };
  };
}

export type SubmitItem = LocalDetailCapture;

export interface SubmitBatchInput {
  readonly batchId: string;
  readonly items: ReadonlyArray<SubmitItem>;
}

export type SubmitOutcome = "submitted" | "paused";

export interface SubmitResult {
  readonly outcome: SubmitOutcome;
  readonly reason?: string;
  readonly accepted?: number;
  readonly products?: ReadonlyArray<{
    sourceItemId: string;
    productId: string;
    revisionId: string;
    created: boolean;
  }>;
  readonly rejected?: ReadonlyArray<{
    sourceItemId?: string;
    sourceUrl?: string;
    reason: string;
  }>;
  readonly items: ReadonlyArray<SubmitItem>;
}

const TOKEN_KEY = "extensionToken";
const PAUSED_SUBMISSION_KEY = "pausedSubmission";
const INGEST_PATH = "/api/v1/local-captures";
const PAUSE_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export interface Submitter {
  buildIdempotencyKeys(sourceItemIds: ReadonlyArray<string>, batchId: string): ReadonlyArray<string>;
  hasToken(): Promise<boolean>;
  submitBatch(input: SubmitBatchInput): Promise<SubmitResult>;
  loadPausedBatch(): Promise<SubmitBatchInput | null>;
}

export function createSubmitter(env: SubmitterEnv): Submitter {
  async function loadToken(): Promise<string | null> {
    const tokenLookup = await env.storage.local.get(TOKEN_KEY);
    const token = tokenLookup[TOKEN_KEY];
    return typeof token === "string" && token.length > 0 ? token : null;
  }

  return {
    async loadPausedBatch() {
      const lookup = await env.storage.local.get(PAUSED_SUBMISSION_KEY);
      return isSubmitBatchInput(lookup[PAUSED_SUBMISSION_KEY]) ? lookup[PAUSED_SUBMISSION_KEY] : null;
    },
    buildIdempotencyKeys(sourceItemIds, batchId) {
      return sourceItemIds.map((id) => `1688:${id}:${batchId}`);
    },
    async hasToken() {
      return (await loadToken()) !== null;
    },
    async submitBatch({ batchId, items }) {
      const keys = items.map((it) => `1688:${it.sourceItemId}:${batchId}`);
      const token = await loadToken();
      if (token === null) {
        await env.storage.local.set({ [PAUSED_SUBMISSION_KEY]: { batchId, items } });
        return Object.freeze({
          outcome: "paused" as const,
          reason: "missing_token",
          items
        });
      }
      const urls = loopbackApiBaseCandidates(env.apiBase)
        .map((base) => `${stripTrailingSlash(base)}${INGEST_PATH}`);
      const body = JSON.stringify({
        version: 3,
        batchId,
        items: items.map((it, i) => ({
          ...it,
          idempotencyKey: keys[i]
        }))
      });
      let resp: Response;
      const requestInit = {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`
        },
        body
      } satisfies RequestInit;
      try {
        resp = await fetchFirstAvailable(urls, requestInit);
      } catch {
        await env.storage.local.set({ [PAUSED_SUBMISSION_KEY]: { batchId, items } });
        return Object.freeze({
          outcome: "paused" as const,
          reason: "api_unavailable",
          items
        });
      }
      if (!resp.ok) {
        if (resp.status === 409) {
          const payload = await resp.json().catch(() => null) as { error?: unknown } | null;
          if (payload?.error === "extension_upgrade_required") {
            await env.storage.local.set({ [PAUSED_SUBMISSION_KEY]: { batchId, items } });
            return Object.freeze({
              outcome: "paused" as const,
              reason: "extension_upgrade_required",
              items
            });
          }
        }
        if (PAUSE_STATUSES.has(resp.status)) {
          await env.storage.local.set({ [PAUSED_SUBMISSION_KEY]: { batchId, items } });
          return Object.freeze({
            outcome: "paused" as const,
            reason: "api_unavailable",
            items
          });
        }
        await env.storage.local.set({ [PAUSED_SUBMISSION_KEY]: { batchId, items } });
        return Object.freeze({
          outcome: "paused" as const,
          reason: `http_${resp.status}`,
          items
        });
      }
      await env.storage.local.remove(PAUSED_SUBMISSION_KEY);
      let accepted = 0;
      let products: NonNullable<SubmitResult["products"]> = [];
      let rejected: NonNullable<SubmitResult["rejected"]> = [];
      try {
        const parsed = (await resp.json()) as {
          accepted?: number;
          products?: SubmitResult["products"];
          rejected?: SubmitResult["rejected"];
        };
        accepted = parsed.accepted ?? items.length;
        products = parsed.products ?? [];
        rejected = parsed.rejected ?? [];
      } catch {
        accepted = items.length;
      }
      return Object.freeze({
        outcome: "submitted" as const,
        accepted,
        products,
        rejected,
        items
      });
    }
  };
}

function isSubmitBatchInput(value: unknown): value is SubmitBatchInput {
  if (!value || typeof value !== "object") return false;
  const input = value as Partial<SubmitBatchInput>;
  return typeof input.batchId === "string" && input.batchId.length > 0 && Array.isArray(input.items);
}

function stripTrailingSlash(s: string): string {
  return s.endsWith("/") ? s.slice(0, -1) : s;
}

function loopbackApiBaseCandidates(apiBase: string): string[] {
  const stripped = stripTrailingSlash(apiBase);
  let parsed: URL;
  try {
    parsed = new URL(stripped);
  } catch {
    return [stripped];
  }
  const aliases = parsed.hostname === "127.0.0.1"
    ? ["127.0.0.1", "localhost"]
    : parsed.hostname === "localhost"
      ? ["localhost", "127.0.0.1"]
      : [parsed.hostname];
  return aliases.map((hostname) => {
    const next = new URL(parsed.toString());
    next.hostname = hostname;
    return stripTrailingSlash(next.toString());
  });
}

async function fetchFirstAvailable(urls: string[], init: RequestInit): Promise<Response> {
  let lastError: unknown;
  for (const url of urls) {
    try {
      return await fetch(url, init);
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error("loopback_api_unavailable");
}
