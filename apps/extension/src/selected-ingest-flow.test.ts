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
    const handler = createBackgroundMessageHandler(submitter);
    const message = createSubmitSelectedMessage("batch_checked_only", store.selectedBatch());
    const response = await new Promise<unknown>((resolve) => {
      expect(handler(message, resolve)).toBe(true);
    });

    expect(response).toMatchObject({ outcome: "submitted", accepted: 1 });
    expect(postedBodies).toEqual([{
      version: 1,
      batchId: "batch_checked_only",
      items: [{
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        idempotencyKey: "1688:892408514788:batch_checked_only"
      }]
    }]);
    expect(JSON.stringify(postedBodies)).not.toContain("892408514999");
    store.stop();
  });
});
