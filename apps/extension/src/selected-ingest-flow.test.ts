// @vitest-environment node
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createBackgroundMessageHandler } from "./background/index.js";
import { createSubmitter, type SubmitterEnv } from "./background/submit-selected.js";
import { createScanStore } from "./content/scan-store.js";
import { createSubmitSelectedMessage } from "./content/store-overlay.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function storageWithToken(token: string): SubmitterEnv["storage"] {
  const values = new Map<string, unknown>([["extensionToken", token]]);
  return {
    local: {
      async get(key) {
        return { [key]: values.get(key) };
      },
      async set(input) {
        for (const [key, value] of Object.entries(input)) values.set(key, value);
      },
      async remove(key) {
        values.delete(key);
      }
    }
  };
}

describe("selected 1688 card to loopback ingest", () => {
  it("sends only the checked preview card through the real content and background chain", async () => {
    const dom = new JSDOM(`<!doctype html><body>
      <article class="offer-card" data-card-id="892408514788">防晒夹克</article>
      <article class="offer-card" data-card-id="892408514999">运动短裤</article>
    </body>`, { url: "https://shop.1688.com/page/offerlist.htm" });
    Object.defineProperty(globalThis, "MutationObserver", {
      value: dom.window.MutationObserver,
      configurable: true
    });

    const store = createScanStore(dom.window.document.body);
    store.start();
    store.select("892408514788", true);
    store.select("892408514999", false);

    const postedBodies: unknown[] = [];
    globalThis.fetch = vi.fn(async (_url, init) => {
      postedBodies.push(JSON.parse(String(init?.body)));
      return Response.json({ accepted: 1 }, { status: 202 });
    }) as typeof fetch;

    const submitter = createSubmitter({
      apiBase: "http://127.0.0.1:3000",
      storage: storageWithToken("local-extension-token")
    });
    const handler = createBackgroundMessageHandler({
      submitter,
      queue: {
        async captureBatch(input) {
          const selected = input.items[0]!;
          return {
            batchId: input.batchId,
            captures: [{
              ...selected,
              mainImages: ["https://img.test/892408514788.jpg"],
              detailImages: [],
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
            }],
            failures: []
          };
        }
      }
    });
    const message = createSubmitSelectedMessage("batch_checked_only", store.selectedBatch());
    const response = await new Promise<unknown>((resolve) => {
      expect(handler(message, resolve)).toBe(true);
    });

    expect(response).toMatchObject({ outcome: "submitted", accepted: 1 });
    expect(postedBodies).toEqual([{
      version: 3,
      batchId: "batch_checked_only",
      items: [{
        sourceItemId: "892408514788",
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        title: "防晒夹克",
        mainImages: ["https://img.test/892408514788.jpg"],
        detailImages: [],
        itemNumber: null,
        category: null,
        sourcePriceWire: null,
        sourcePriceRangeWire: null,
        sourceStock: null,
        weightKg: null,
        dimensionsCm: null,
        attributes: [],
        saleAttributes: [],
        skuAttributes: [],
        skuText: [],
        colors: [],
        sizes: [],
        skus: [],
        capturedAt: "2026-07-24T08:00:00.000Z",
        captureQuality: "detail_page_complete",
        diagnostics: {
          version: 2,
          pageKind: "offer_detail",
          titleSource: "page_context",
          stableForMs: 2000,
          fieldEvidence: {
            title: "captured",
            mainImages: "captured",
            detail: "source_absent",
            attributes: "source_absent",
            price: "source_absent",
            stock: "source_absent",
            skus: "source_absent",
            weight: "source_absent",
            dimensions: "source_absent"
          },
          expectedSkuCount: null,
          capturedSkuCount: 0,
          acceptedMainImages: 1,
          acceptedDetailImages: 0,
          rejectedImages: 0,
          warnings: []
        },
        idempotencyKey: "1688:892408514788:batch_checked_only"
      }]
    }]);
    expect(JSON.stringify(postedBodies)).not.toContain("892408514999");
    store.stop();
  });
});
