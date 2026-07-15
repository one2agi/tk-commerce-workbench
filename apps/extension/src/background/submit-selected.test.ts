// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubmitter,
  type SubmitterEnv
} from "./submit-selected.js";

function makeFetchMock(responses: Array<{ ok: boolean; status: number; body: unknown }>) {
  let i = 0;
  return vi.fn(async () => {
    const fallback = responses[responses.length - 1];
    const r = responses[i++] ?? fallback;
    if (!r) throw new Error("no response configured");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" }
    });
  });
}

function makeChromeStorage(initial: Record<string, unknown>) {
  const store = new Map(Object.entries(initial));
  return {
    local: {
      get: vi.fn(async (key: string) => {
        const out: Record<string, unknown> = {};
        out[key] = store.get(key);
        return out;
      }),
      set: vi.fn(async (obj: Record<string, unknown>) => {
        for (const [k, v] of Object.entries(obj)) store.set(k, v);
      })
    }
  };
}

describe("submit-selected", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  let env: SubmitterEnv;

  beforeEach(() => {
    env = {
      apiBase: "http://127.0.0.1:8787",
      storage: makeChromeStorage({ extensionToken: "tok-secret" }) as unknown as SubmitterEnv["storage"]
    };
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
  });

  it("generates exactly one idempotency key per selected product", () => {
    const submitter = createSubmitter(env);
    const keys = submitter.buildIdempotencyKeys(
      ["892408514788", "777777777777"],
      "batch_01"
    );
    expect(keys).toEqual([
      "1688:892408514788:batch_01",
      "1688:777777777777:batch_01"
    ]);
    expect(new Set(keys).size).toBe(2);
  });

  it("attaches Bearer token from chrome.storage.local", async () => {
    const fetchMock = makeFetchMock([{ ok: true, status: 200, body: { accepted: 1 } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const submitter = createSubmitter(env);
    const result = await submitter.submitBatch({
      batchId: "batch_01",
      items: [
        { sourceItemId: "892408514788", sourceUrl: "https://detail.1688.com/offer/892408514788.html" }
      ]
    });

    expect(result.outcome).toBe("submitted");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/v1/ingest-links");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-secret");
  });

  it("pauses the batch (does not drop) when loopback API fails", async () => {
    const fetchMock = makeFetchMock([{ ok: false, status: 503, body: { error: "down" } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const submitter = createSubmitter(env);
    const result = await submitter.submitBatch({
      batchId: "batch_01",
      items: [
        { sourceItemId: "892408514788", sourceUrl: "https://detail.1688.com/offer/892408514788.html" }
      ]
    });

    expect(result.outcome).toBe("paused");
    expect(result.reason).toBe("api_unavailable");
    // The batch must not be silently dropped.
    const items = result.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceItemId).toBe("892408514788");
  });
});