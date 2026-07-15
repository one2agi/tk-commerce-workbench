import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createMiaoshouSourceAdapter,
  type MiaoshouHttp,
  type MiaoshouConfig
} from "./source-adapter.js";
import {
  sourceItemId as toSourceItemId,
  idempotencyKey as toIdempotencyKey,
  CollectionWarningCodes
} from "@tk/contracts";

const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../tests/fixtures/external/miaoshou", import.meta.url)
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/${name}`, "utf8"));
}

// A recording HTTP client: lets a test wire up specific JSON responses keyed by path.
function createFakeHttp(responses: Record<string, () => unknown>): MiaoshouHttp & {
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body });
      const r = responses[path];
      if (!r) throw new Error(`unexpected POST ${path}`);
      return r() as T;
    }
  };
}

const BASE_CONFIG: MiaoshouConfig = {
  baseUrl: "https://api.miaoshou.test",
  appKey: "test-key",
  appSecret: "test-secret"
};

describe("Miaoshou source adapter", () => {
  it("collects a fresh offer (success path) and maps the detail", async () => {
    // Fresh fetch_item returns success with detailId 3801638367; this detail
    // is itself the canonical success and gets returned directly. Shape per
    // Spec: fetchDetailId = fetch_item's detailId; canonicalSuccessDetailId
    // = same value when the freshly-fetched detail succeeded.
    const fetchSuccess = readFixture("fetch-success.json");
    const detail = readFixture("detail-3799770548.json");
    const http = createFakeHttp({
      "/open/v1/product/common_collect_box/common_collect_box/fetch_item": () => fetchSuccess,
      "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail": () => detail
    });

    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });
    const result = await adapter.fetchItem({
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      idempotencyKey: toIdempotencyKey("idem_01")
    });

    expect(result.fetchDetailId).toBe("3801638367");
    expect(result.skippedDetailId).toBeNull();
    expect(result.canonicalSuccessDetailId).toBe("3801638367");
    expect(result.detail.sourceItemId).toBe(toSourceItemId("892408514788"));
    expect(result.detail.mainImages).toHaveLength(9);
    expect(result.detail.detailImages).toHaveLength(5);
    expect(result.detail.skus).toHaveLength(28);
    expect(result.detail.colors).toHaveLength(4);
    expect(result.detail.sizes).toHaveLength(7);
    expect(result.detail.weightKg).toBe("0.35");
    expect(result.detail.dimensionsCm).toBeNull();
    expect(result.detail.itemNumber).toBeNull();
  });

  it("on a skip response, picks the most recent success detail as canonical and never queries the skip", async () => {
    const fetchSkip = readFixture("fetch-duplicate-skip.json");
    const list = readFixture("collect-box-list.json");
    const detail = readFixture("detail-3799770548.json");

    const http = createFakeHttp({
      "/open/v1/product/common_collect_box/common_collect_box/fetch_item": () => fetchSkip,
      "/open/v1/product/common_collect_box/common_collect_box/list": () => list,
      "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail": () => detail
    });

    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });
    const result = await adapter.fetchItem({
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      idempotencyKey: toIdempotencyKey("idem_01")
    });

    expect(result.skippedDetailId).toBe("3801638000");
    expect(result.canonicalSuccessDetailId).toBe("3799770548");

    const detailCalls = http.calls.filter(
      (c) => c.path === "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail"
    );
    expect(detailCalls).toHaveLength(1);
    // The known skip detail id is NEVER the one queried.
    const firstDetailCall = detailCalls[0];
    expect(firstDetailCall).toBeDefined();
    const queriedBody = firstDetailCall?.body as { detailId: string };
    expect(queriedBody.detailId).toBe("3799770548");
    expect(queriedBody.detailId).not.toBe("3801638000");
  });

  it("returns 'invalid' when source item id is missing or there are zero usable product images", async () => {
    const http = createFakeHttp({});
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });
    const r1 = await adapter.fetchItem({
      sourceUrl: "not-a-url",
      idempotencyKey: toIdempotencyKey("idem_x")
    });
    expect(r1.fetchDetailId).toBeNull();
    expect(r1.detail.mainImages).toHaveLength(0);
    expect(r1.canonicalSuccessDetailId).toBe("");
  });

  it("returns 'partial' with stable warning codes when title/sourcePrice/SKU/weight/subset are missing", async () => {
    const partialDetail = {
      code: 0,
      msg: "ok",
      data: {
        detailId: "3799770999",
        sourceItemId: "999999999999",
        sourceUrl: "https://detail.1688.com/offer/999999999999.html",
        title: "",
        itemNumber: null,
        description: "",
        category: null,
        sourcePrice: null,
        sourceStock: null,
        weightKg: null,
        mainImages: [{ url: "https://x/a.jpg", width: 1, height: 1 }],
        detailImages: [],
        sourceAttributes: [],
        saleAttributes: [],
        colors: [],
        sizes: [],
        skus: []
      }
    };
    const http = createFakeHttp({
      "/open/v1/product/common_collect_box/common_collect_box/fetch_item": () => ({
        code: 0,
        data: { status: "success", detailId: "3799770999", sourceItemId: "999999999999" }
      }),
      "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail": () => partialDetail
    });
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });
    const result = await adapter.fetchItem({
      sourceUrl: "https://detail.1688.com/offer/999999999999.html",
      idempotencyKey: toIdempotencyKey("idem_02")
    });

    expect(result.canonicalSuccessDetailId).toBe("3799770999");
    // Map into a partial-by-warning shape via public summary.
    const summary = adapter.summarize(result);
    expect(summary.status).toBe("partial");
    expect(summary.warnings).toContain(CollectionWarningCodes.MissingTitle);
    expect(summary.warnings).toContain(CollectionWarningCodes.MissingSourcePrice);
    expect(summary.warnings).toContain(CollectionWarningCodes.MissingSku);
    expect(summary.warnings).toContain(CollectionWarningCodes.MissingWeight);
  });
});