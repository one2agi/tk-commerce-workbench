import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CollectionWarningCodes,
  idempotencyKey as toIdempotencyKey,
  sourceItemId as toSourceItemId
} from "@tk/contracts";
import {
  createMiaoshouSourceAdapter,
  type MiaoshouConfig,
  type MiaoshouHttp
} from "./source-adapter.js";

const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../tests/fixtures/external/miaoshou", import.meta.url)
);

function readFixture(name: string): unknown {
  return JSON.parse(readFileSync(`${FIXTURES_DIR}/${name}`, "utf8"));
}

function createFakeHttp(responses: Record<string, () => unknown>): MiaoshouHttp & {
  calls: Array<{ path: string; body: unknown }>;
} {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body });
      const response = responses[path];
      if (!response) throw new Error(`unexpected POST ${path}`);
      return response() as T;
    }
  };
}

const BASE_CONFIG: MiaoshouConfig = {
  baseUrl: "https://api.miaoshou.test",
  appKey: "test-key",
  appSecret: "test-secret"
};
const FETCH = "/open/v1/product/common_collect_box/common_collect_box/fetch_item";
const LIST = "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list";
const DETAIL = "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail";

describe("Miaoshou source adapter", () => {
  it("uses the real fetch/list/detail request shapes and maps the verified detail", async () => {
    const http = createFakeHttp({
      [FETCH]: () => readFixture("fetch-success.json"),
      [LIST]: () => readFixture("collect-box-list.json"),
      [DETAIL]: () => readFixture("detail-3799770548.json")
    });
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });

    const result = await adapter.fetchItem({
      sourceUrl:
        "https://detail.1688.com/offer/892408514788.html?spm=x&offerId=892408514788",
      idempotencyKey: toIdempotencyKey("idem_01")
    });

    expect(http.calls).toEqual([
      {
        path: FETCH,
        body: { collectLinks: ["https://detail.1688.com/offer/892408514788.html"] }
      },
      {
        path: LIST,
        body: {
          pageNo: 1,
          pageSize: 20,
          filter: { tabPaneName: "all", sourceItemIdKeyword: "892408514788" }
        }
      },
      { path: DETAIL, body: { commonCollectBoxDetailId: 3799770548 } }
    ]);
    expect(result.fetchDetailId).toBe("3799770548");
    expect(result.skippedDetailId).toBeNull();
    expect(result.canonicalSuccessDetailId).toBe("3799770548");
    expect(result.detail.sourceItemId).toBe(toSourceItemId("892408514788"));
    expect(result.detail.sourceUrl).toBe(
      "https://detail.1688.com/offer/892408514788.html"
    );
    expect(result.detail.title).toContain("工装短裤");
    expect(result.detail.sourcePriceWire).toEqual({ amountMinor: "600", currency: "CNY" });
    expect(result.detail.sourceStock).toBe(53_203);
    expect(result.detail.weightKg).toBe("0.3");
    expect(result.detail.mainImages).toHaveLength(9);
    expect(result.detail.detailImages).toHaveLength(5);
    expect(result.detail.skus).toHaveLength(28);
    expect(result.detail.colors).toHaveLength(4);
    expect(result.detail.sizes).toHaveLength(7);
    expect(result.detail.dimensionsCm).toBeNull();
    expect(result.detail.itemNumber).toBe("26");
  });

  it("does not treat a returned detail id as canonical when the list exposes a failed record", async () => {
    const http = createFakeHttp({
      [FETCH]: () => readFixture("fetch-duplicate-skip.json"),
      [LIST]: () => readFixture("collect-box-list.json"),
      [DETAIL]: () => readFixture("detail-3799770548.json")
    });
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });

    const result = await adapter.fetchItem({
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      idempotencyKey: toIdempotencyKey("idem_02")
    });

    expect(result.fetchDetailId).toBe("3801638367");
    expect(result.skippedDetailId).toBe("3801638367");
    expect(result.canonicalSuccessDetailId).toBe("3799770548");
    expect(http.calls.at(-1)).toEqual({
      path: DETAIL,
      body: { commonCollectBoxDetailId: 3799770548 }
    });
  });

  it("rejects an invalid source URL without making an API request", async () => {
    const http = createFakeHttp({});
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });

    await expect(
      adapter.fetchItem({
        sourceUrl: "not-a-url",
        idempotencyKey: toIdempotencyKey("idem_invalid")
      })
    ).rejects.toMatchObject({ kind: "needs_input", code: "miaoshou.invalid_source_url" });
    expect(http.calls).toHaveLength(0);
  });

  it("classifies a not-yet-queryable canonical detail as retryable", async () => {
    const http = createFakeHttp({
      [FETCH]: () => readFixture("fetch-success.json"),
      [LIST]: () => ({ result: "success", code: "200", data: { detailList: [] } })
    });
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });

    await expect(
      adapter.fetchItem({
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        idempotencyKey: toIdempotencyKey("idem_pending")
      })
    ).rejects.toMatchObject({ kind: "retryable", code: "miaoshou.detail_pending" });
  });

  it("continues to page two to resolve the exact canonical source record", async () => {
    let listPage = 0;
    const unrelated = Array.from({ length: 20 }, (_, index) => ({
      commonCollectBoxDetailId: 1000 + index,
      status: "noClaimed",
      sourceList: [{ sourceItemId: `other-${index}` }]
    }));
    const http = createFakeHttp({
      [FETCH]: () => readFixture("fetch-duplicate-skip.json"),
      [LIST]: () => ++listPage === 1
        ? { result: "success", code: "200", data: { detailList: unrelated, total: 21 } }
        : { result: "success", code: "200", data: { detailList: [{ commonCollectBoxDetailId: 3799770548, status: "noClaimed", gmtModified: "2026-07-14 09:00:00", sourceList: [{ sourceItemId: "892408514788" }] }], total: 21 } },
      [DETAIL]: () => readFixture("detail-3799770548.json")
    });
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });
    const result = await adapter.fetchItem({ sourceUrl: "https://detail.1688.com/offer/892408514788.html", idempotencyKey: toIdempotencyKey("idem_page_2") });
    expect(result.canonicalSuccessDetailId).toBe("3799770548");
    expect(http.calls.filter((call) => call.path === LIST).map((call) => call.body)).toEqual([
      { pageNo: 1, pageSize: 20, filter: { tabPaneName: "all", sourceItemIdKeyword: "892408514788" } },
      { pageNo: 2, pageSize: 20, filter: { tabPaneName: "all", sourceItemIdKeyword: "892408514788" } }
    ]);
  });

  it.each([
    ["signInvalid", "needs_input"],
    ["appNoPermission", "needs_input"],
    ["ipNotInWhitelist", "needs_input"],
    ["missingRequiredField", "needs_input"],
    ["productNotFound", "fatal"],
    ["accountQpsRateLimit", "retryable"]
  ])("classifies API code %s as %s", async (code, kind) => {
    const http = createFakeHttp({ [FETCH]: () => ({ result: "fail", code, message: "unsafe upstream message" }) });
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });
    await expect(adapter.fetchItem({ sourceUrl: "https://detail.1688.com/offer/892408514788.html", idempotencyKey: toIdempotencyKey(`idem_${code}`) }))
      .rejects.toMatchObject({ kind, code: `miaoshou.${code}` });
  });

  it("reports stable warnings for real missing fields", async () => {
    const http = createFakeHttp({
      [FETCH]: () => readFixture("fetch-success.json"),
      [LIST]: () => readFixture("collect-box-list.json"),
      [DETAIL]: () => readFixture("detail-3799770548.json")
    });
    const adapter = createMiaoshouSourceAdapter({ http, config: BASE_CONFIG });
    const result = await adapter.fetchItem({
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      idempotencyKey: toIdempotencyKey("idem_warnings")
    });

    expect(adapter.summarize(result).warnings).toEqual(
      expect.arrayContaining([
        CollectionWarningCodes.MissingDimensions,
        CollectionWarningCodes.MissingSizeChart,
        CollectionWarningCodes.MissingVideo,
        CollectionWarningCodes.MissingCertification
      ])
    );
  });
});
