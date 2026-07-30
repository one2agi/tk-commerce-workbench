// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createSubmitter,
  type SubmitterEnv
} from "./submit-selected.js";

function capturedItem(sourceItemId = "892408514788") {
  return {
    sourceItemId,
    sourceUrl: `https://detail.1688.com/offer/${sourceItemId}.html`,
    title: `商品 ${sourceItemId}`,
    mainImages: [`https://img.test/${sourceItemId}.jpg`],
    detailImages: [],
    descriptionText: undefined,
    itemNumber: null,
    category: null,
    sourcePriceWire: null,
    sourcePriceRangeWire: null,
    sourceStock: null,
    weightKg: null,
    dimensionsCm: null,
    attributes: [],
    saleAttributes: [],
    skuText: [],
    capturedAt: "2026-07-24T08:00:00.000Z",
    captureQuality: "detail_page_complete" as const,
    skuAttributes: [],
    colors: [],
    sizes: [],
    skus: [],
    diagnostics: {
      version: 2 as const,
      pageKind: "offer_detail" as const,
      titleSource: "page_context" as const,
      stableForMs: 2000,
      fieldEvidence: {
        title: "captured" as const,
        mainImages: "captured" as const,
        detail: "source_absent" as const,
        attributes: "source_absent" as const,
        price: "source_absent" as const,
        stock: "source_absent" as const,
        skus: "source_absent" as const,
        weight: "source_absent" as const,
        dimensions: "source_absent" as const
      },
      expectedSkuCount: null,
      capturedSkuCount: 0,
      acceptedMainImages: 1,
      acceptedDetailImages: 0,
      rejectedImages: 0,
      warnings: []
    }
  };
}

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

function makeMixedFetchMock(responses: Array<Response | Error>) {
  let i = 0;
  return vi.fn(async () => {
    const r = responses[i++] ?? responses[responses.length - 1];
    if (r instanceof Error) throw r;
    return r;
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
      }),
      remove: vi.fn(async (key: string) => { store.delete(key); })
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
    const fetchMock = makeFetchMock([{
      ok: true,
      status: 200,
      body: {
        accepted: 1,
        products: [{
          sourceItemId: "892408514788",
          productId: "prod-1",
          revisionId: "rev-1",
          created: true
        }],
        rejected: []
      }
    }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const submitter = createSubmitter(env);
    const result = await submitter.submitBatch({
      batchId: "batch_01",
      items: [capturedItem()]
    });

    expect(result.outcome).toBe("submitted");
    expect(result.products).toEqual([{
      sourceItemId: "892408514788",
      productId: "prod-1",
      revisionId: "rev-1",
      created: true
    }]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calls = fetchMock.mock.calls as unknown as Array<[string, RequestInit]>;
    const firstCall = calls[0];
    expect(firstCall).toBeDefined();
    const [url, init] = firstCall as [string, RequestInit];
    expect(url).toBe("http://127.0.0.1:8787/api/v1/local-captures");
    const headers = (init.headers ?? {}) as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer tok-secret");
    expect(JSON.parse(String(init.body))).toMatchObject({
      version: 3,
      batchId: "batch_01",
      items: [{
        sourceItemId: "892408514788",
        title: "商品 892408514788",
        idempotencyKey: "1688:892408514788:batch_01"
      }]
    });
  });

  it("pauses the batch (does not drop) when loopback API fails", async () => {
    const fetchMock = makeFetchMock([{ ok: false, status: 503, body: { error: "down" } }]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const submitter = createSubmitter(env);
    const result = await submitter.submitBatch({
      batchId: "batch_01",
      items: [capturedItem()]
    });

    expect(result.outcome).toBe("paused");
    expect(result.reason).toBe("api_unavailable");
    // The batch must not be silently dropped.
    const items = result.items ?? [];
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceItemId).toBe("892408514788");
    await expect(submitter.loadPausedBatch()).resolves.toMatchObject({ batchId: "batch_01" });
  });

  it("falls back from 127.0.0.1 to localhost when the first loopback alias is unavailable", async () => {
    const fetchMock = makeMixedFetchMock([
      new Error("connection refused"),
      new Response(JSON.stringify({ accepted: 1 }), {
        status: 201,
        headers: { "content-type": "application/json" }
      })
    ]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await createSubmitter({
      apiBase: "http://127.0.0.1:3000",
      storage: env.storage
    }).submitBatch({
      batchId: "batch_01",
      items: [capturedItem()]
    });

    expect(result).toMatchObject({ outcome: "submitted", accepted: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0] as unknown[])[0]).toBe("http://127.0.0.1:3000/api/v1/local-captures");
    expect((fetchMock.mock.calls[1] as unknown[])[0]).toBe("http://localhost:3000/api/v1/local-captures");
  });

  it("surfaces the explicit extension-upgrade response from the V3 ingest gate", async () => {
    globalThis.fetch = makeFetchMock([{
      ok: false,
      status: 409,
      body: { error: "extension_upgrade_required", requiredVersion: 3 }
    }]) as unknown as typeof fetch;

    const result = await createSubmitter(env).submitBatch({
      batchId: "batch_legacy",
      items: [capturedItem()]
    });

    expect(result).toMatchObject({
      outcome: "paused",
      reason: "extension_upgrade_required"
    });
  });

  it("restores a paused batch after restart and clears it after retry", async () => {
    const storage = makeChromeStorage({
      extensionToken: "tok-secret",
      pausedSubmission: { batchId: "batch_saved", items: [capturedItem()] }
    });
    const submitter = createSubmitter({ apiBase: env.apiBase, storage: storage as unknown as SubmitterEnv["storage"] });
    const saved = await submitter.loadPausedBatch();
    expect(saved).toMatchObject({ batchId: "batch_saved" });
    globalThis.fetch = makeFetchMock([{ ok: true, status: 200, body: { accepted: 1 } }]) as unknown as typeof fetch;
    await submitter.submitBatch(saved!);
    await expect(submitter.loadPausedBatch()).resolves.toBeNull();
  });
});
