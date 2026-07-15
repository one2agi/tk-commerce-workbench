// Background service-worker submitter: posts the selected-only batch to the
// loopback Ingest Links API with one idempotency key per product, attaching
// the Bearer token from chrome.storage.local. On loopback API failure the
// batch is PAUSED (never silently dropped).

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

export interface SubmitItem {
  readonly sourceItemId: string;
  readonly sourceUrl: string;
}

export interface SubmitBatchInput {
  readonly batchId: string;
  readonly items: ReadonlyArray<SubmitItem>;
}

export type SubmitOutcome = "submitted" | "paused";

export interface SubmitResult {
  readonly outcome: SubmitOutcome;
  readonly reason?: string;
  readonly accepted?: number;
  readonly items: ReadonlyArray<SubmitItem>;
}

const TOKEN_KEY = "extensionToken";
const PAUSED_SUBMISSION_KEY = "pausedSubmission";
const INGEST_PATH = "/api/v1/ingest-links";
const PAUSE_STATUSES = new Set([0, 408, 425, 429, 500, 502, 503, 504]);

export interface Submitter {
  buildIdempotencyKeys(sourceItemIds: ReadonlyArray<string>, batchId: string): ReadonlyArray<string>;
  submitBatch(input: SubmitBatchInput): Promise<SubmitResult>;
  loadPausedBatch(): Promise<SubmitBatchInput | null>;
}

export function createSubmitter(env: SubmitterEnv): Submitter {
  return {
    async loadPausedBatch() {
      const lookup = await env.storage.local.get(PAUSED_SUBMISSION_KEY);
      return isSubmitBatchInput(lookup[PAUSED_SUBMISSION_KEY]) ? lookup[PAUSED_SUBMISSION_KEY] : null;
    },
    buildIdempotencyKeys(sourceItemIds, batchId) {
      return sourceItemIds.map((id) => `1688:${id}:${batchId}`);
    },
    async submitBatch({ batchId, items }) {
      const keys = items.map((it) => `1688:${it.sourceItemId}:${batchId}`);
      const tokenLookup = await env.storage.local.get(TOKEN_KEY);
      const token = tokenLookup[TOKEN_KEY];
      if (typeof token !== "string" || token.length === 0) {
        await env.storage.local.set({ [PAUSED_SUBMISSION_KEY]: { batchId, items } });
        return Object.freeze({
          outcome: "paused" as const,
          reason: "missing_token",
          items
        });
      }
      const url = `${stripTrailingSlash(env.apiBase)}${INGEST_PATH}`;
      const body = JSON.stringify({
        version: 1,
        batchId,
        items: items.map((it, i) => ({
          sourceUrl: it.sourceUrl,
          idempotencyKey: keys[i]
        }))
      });
      let resp: Response;
      try {
        resp = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            Authorization: `Bearer ${token}`
          },
          body
        });
      } catch {
        await env.storage.local.set({ [PAUSED_SUBMISSION_KEY]: { batchId, items } });
        return Object.freeze({
          outcome: "paused" as const,
          reason: "api_unavailable",
          items
        });
      }
      if (!resp.ok) {
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
      try {
        const parsed = (await resp.json()) as { accepted?: number };
        accepted = parsed.accepted ?? items.length;
      } catch {
        accepted = items.length;
      }
      return Object.freeze({
        outcome: "submitted" as const,
        accepted,
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
