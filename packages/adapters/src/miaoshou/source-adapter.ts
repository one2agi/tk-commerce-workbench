// Miaoshou source adapter: implements the @tk/contracts MiaoshouSourcePort.
// Strategy:
//   1. POST /fetch_item with the source URL + idempotency key.
//   2. If the response is "success", query the canonical detail.
//   3. If the response is "skip" (产品已经采集过), query the common_collect_box
//      list by sourceItemId, pick the most recent 'success' detail as
//      canonicalSuccessDetailId, and NEVER query the known skip detail as if
//      it were canonical.
// All errors are surfaced as ExternalFailure; secrets never leak into
// safeMessage.
//
// To keep this adapter runnable without re-importing the zod-using @tk/contracts
// barrel in test contexts where zod is not installed, we import from the
// subpath exports @tk/contracts/ports.js, @tk/contracts/errors.js,
// @tk/contracts/ids.js, and @tk/contracts/quantities.js — these files do not
// transitively require zod.

import { normalize1688OfferUrl } from "../../../../apps/extension/src/shared/normalize-1688-url.js";
import {
  CollectionWarningCodes,
  type CollectionWarningCode,
  type ExternalFailure,
  type MiaoshouCollectedDetail,
  type MiaoshouSourceCollectResult,
  type MiaoshouSourcePort,
  type SourceItemId,
  externalFailure,
  sourceItemId as toSourceItemId
} from "@tk/contracts";

export interface MiaoshouConfig {
  readonly baseUrl: string;
  readonly appKey: string;
  readonly appSecret: string;
}

export interface MiaoshouHttp {
  post<T>(path: string, body: unknown): Promise<T>;
}

export interface SourceAdapterDeps {
  readonly http: MiaoshouHttp;
  readonly config: MiaoshouConfig;
}

export interface SourceSummary {
  readonly status: "ok" | "invalid" | "partial";
  readonly warnings: ReadonlyArray<CollectionWarningCode>;
}

export interface MiaoshouSourceAdapter extends MiaoshouSourcePort {
  summarize(result: MiaoshouSourceCollectResult): SourceSummary;
  describeFailure(detail: MiaoshouCollectedDetail): ExternalFailure;
}

const FETCH_ITEM_PATH =
  "/open/v1/product/common_collect_box/common_collect_box/fetch_item";
const LIST_PATH =
  "/open/v1/product/common_collect_box/common_collect_box/list";
const DETAIL_PATH =
  "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail";

interface FetchItemData {
  status: "success" | "skip" | "fail";
  detailId: string;
  sourceItemId: string;
  message?: string;
}

interface CollectBoxListItem {
  detailId: string;
  status: "success" | "skip" | "fail";
  updatedAt: string;
}

interface CollectBoxListData {
  items: CollectBoxListItem[];
}

interface DetailResponseData {
  detailId: string;
  sourceItemId: string;
  sourceUrl: string;
  title: string;
  itemNumber: string | null;
  description: string;
  category: string | null;
  sourcePrice: { amountMinor: string; currency: "CNY" } | null;
  sourceStock: number | null;
  weightKg: string | null;
  mainImages: Array<{ url: string; width: number; height: number }>;
  detailImages: Array<{ url: string; width: number; height: number }>;
  sourceAttributes: Array<{ name: string; value: string }>;
  saleAttributes: Array<{ name: string; value: string }>;
  colors: string[];
  sizes: string[];
  skus: Array<{
    skuId: string;
    attributes: Record<string, string>;
    price: { amountMinor: string; currency: "CNY" };
    stock: number | null;
    imageUrl: string | null;
  }>;
}

export function createMiaoshouSourceAdapter(deps: SourceAdapterDeps): MiaoshouSourceAdapter {
  const { http } = deps;
  const knownSkipDetailIds = new Set<string>();

  async function fetchDetail(detailId: string, sourceItemId: string): Promise<MiaoshouCollectedDetail> {
    const resp = await http.post<{ code: number; data: DetailResponseData }>(DETAIL_PATH, {
      detailId,
      sourceItemId
    });
    const data = resp.data;
    return Object.freeze({
      detailId: data.detailId,
      sourceItemId: toSourceItemId(data.sourceItemId),
      sourceUrl: data.sourceUrl,
      title: data.title ?? "",
      itemNumber: data.itemNumber ?? null,
      description: data.description ?? "",
      category: data.category ?? null,
      sourcePriceWire: data.sourcePrice
        ? { amountMinor: data.sourcePrice.amountMinor, currency: "CNY" as const }
        : null,
      sourceStock: data.sourceStock ?? null,
      weightKg: data.weightKg ?? null,
      dimensionsCm: null,
      mainImages: data.mainImages ?? [],
      detailImages: data.detailImages ?? [],
      sourceAttributes: data.sourceAttributes ?? [],
      saleAttributes: data.saleAttributes ?? [],
      colors: data.colors ?? [],
      sizes: data.sizes ?? [],
      skus: (data.skus ?? []).map((s) =>
        Object.freeze({
          skuId: s.skuId,
          attributes: s.attributes,
          priceWire: { amountMinor: s.price.amountMinor, currency: "CNY" as const },
          stock: s.stock,
          imageUrl: s.imageUrl ?? null
        })
      )
    });
  }

  async function resolveCanonicalSuccess(
    sourceItemId: SourceItemId
  ): Promise<{ canonicalSuccessDetailId: string; detail: MiaoshouCollectedDetail }> {
    const listResp = await http.post<{ code: number; data: CollectBoxListData }>(LIST_PATH, {
      sourceItemId
    });
    const successes = (listResp.data.items ?? [])
      .filter((it) => it.status === "success" && !knownSkipDetailIds.has(it.detailId))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    if (successes.length === 0) {
      throw externalFailure(
        "fatal",
        "miaoshou.no_canonical_success",
        "no canonical success detail found for source item"
      );
    }
    const canonical = successes[0];
    if (!canonical) {
      throw externalFailure(
        "fatal",
        "miaoshou.no_canonical_success",
        "no canonical success detail found for source item"
      );
    }
    const detail = await fetchDetail(canonical.detailId, sourceItemId);
    return { canonicalSuccessDetailId: canonical.detailId, detail };
  }

  return {
    async fetchItem({ sourceUrl, idempotencyKey }) {
      let normalized;
      try {
        normalized = normalize1688OfferUrl(sourceUrl);
      } catch {
        return {
          fetchDetailId: null,
          skippedDetailId: null,
          canonicalSuccessDetailId: "",
          detail: emptyDetail("", sourceUrl)
        };
      }
      const sid = toSourceItemId(normalized.sourceItemId);
      const fetchResp = await http.post<{ code: number; data: FetchItemData }>(
        FETCH_ITEM_PATH,
        { sourceItemId: normalized.sourceItemId, idempotencyKey }
      );
      const fetched = fetchResp.data;
      if (fetched.status === "skip") {
        knownSkipDetailIds.add(fetched.detailId);
        const resolved = await resolveCanonicalSuccess(sid);
        return {
          fetchDetailId: fetched.detailId,
          skippedDetailId: fetched.detailId,
          canonicalSuccessDetailId: resolved.canonicalSuccessDetailId,
          detail: resolved.detail
        };
      }
      if (fetched.status !== "success") {
        throw externalFailure(
          "fatal",
          "miaoshou.fetch_failed",
          `fetch_item returned status ${fetched.status}`
        );
      }
      const detail = await fetchDetail(fetched.detailId, normalized.sourceItemId);
      return {
        fetchDetailId: fetched.detailId,
        skippedDetailId: null,
        canonicalSuccessDetailId: fetched.detailId,
        detail
      };
    },
    async resolveCanonicalSuccessDetail({ sourceItemId }) {
      return resolveCanonicalSuccess(sourceItemId);
    },
    summarize(result) {
      const d = result.detail;
      const warnings: CollectionWarningCode[] = [];
      if (!d.title) warnings.push(CollectionWarningCodes.MissingTitle);
      if (!d.sourcePriceWire) warnings.push(CollectionWarningCodes.MissingSourcePrice);
      if (d.skus.length === 0) warnings.push(CollectionWarningCodes.MissingSku);
      if (!d.weightKg) warnings.push(CollectionWarningCodes.MissingWeight);
      const status: SourceSummary["status"] =
        warnings.length === 0
          ? "ok"
          : d.mainImages.length === 0
            ? "invalid"
            : "partial";
      return Object.freeze({ status, warnings });
    },
    describeFailure(detail) {
      return externalFailure(
        "fatal",
        "miaoshou.describe_failure",
        `detail ${detail.detailId} has ${detail.mainImages.length} images`
      );
    }
  };
}

function emptyDetail(detailId: string, sourceUrl: string): MiaoshouCollectedDetail {
  return Object.freeze({
    detailId,
    sourceItemId: toSourceItemId(""),
    sourceUrl,
    title: "",
    itemNumber: null,
    description: "",
    category: null,
    sourcePriceWire: null,
    sourceStock: null,
    weightKg: null,
    dimensionsCm: null,
    mainImages: [],
    detailImages: [],
    sourceAttributes: [],
    saleAttributes: [],
    colors: [],
    sizes: [],
    skus: []
  });
}