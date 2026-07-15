import {
  CollectionWarningCodes,
  externalFailure,
  normalize1688OfferUrl,
  sourceItemId as toSourceItemId,
  type CollectionWarningCode,
  type ExternalFailure,
  type MiaoshouCollectedDetail,
  type MiaoshouSourceCollectResult,
  type MiaoshouSourcePort,
  type SourceItemId
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
  "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_list";
const DETAIL_PATH =
  "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail";

type ApiEnvelope<T> = {
  result: "success" | "fail";
  code: string | number;
  message?: string;
  data?: T;
};

interface FetchItemData {
  sourceItemIdAndDetailIdMap?: Record<string, string | number>;
}

interface SourceLink {
  source?: string;
  sourceItemId?: string;
  sourceItemUrl?: string;
}

interface CollectBoxListItem {
  commonCollectBoxDetailId: string | number;
  status?: string;
  reason?: string;
  gmtModified?: string;
  sourceList?: SourceLink[];
}

interface CollectBoxListData {
  detailList?: CollectBoxListItem[];
}

interface RawSku {
  itemNum?: string | null;
  price?: string | number | null;
  stock?: number | null;
  imgUrl?: string | null;
  imageUrl?: string | null;
}

interface RawDetail {
  commonCollectBoxDetailId: string | number;
  title?: string;
  itemNum?: string | null;
  notesText?: string;
  notes?: string;
  price?: string | number | null;
  stock?: number | null;
  weight?: string | number | null;
  packageLength?: string | number | null;
  packageWidth?: string | number | null;
  packageHeight?: string | number | null;
  cateList?: string[];
  imgUrls?: string[];
  sourceAttrs?: Array<{ name: string; value: string }>;
  colorPropName?: string;
  colorMap?: Record<string, unknown>;
  sizePropName?: string;
  sizeMap?: Record<string, unknown>;
  saleProp3Name?: string;
  skuMap?: Record<string, RawSku>;
  sourceList?: SourceLink[];
  sizeChart?: string | null;
  mainImgVideoUrl?: string | null;
  productCertifications?: unknown[];
}

interface DetailData {
  editCommonCollectBoxDetail?: RawDetail;
}

function requireSuccess<T>(response: ApiEnvelope<T>, code: string): T {
  if (response.result !== "success" || !response.data) {
    throw externalFailure("retryable", code, "Miaoshou API is temporarily unavailable");
  }
  return response.data;
}

function isSource(item: CollectBoxListItem, sourceItemId: string): boolean {
  return (item.sourceList ?? []).some(
    (source) => String(source.sourceItemId ?? "") === sourceItemId
  );
}

function isUsable(item: CollectBoxListItem): boolean {
  const status = (item.status ?? "").toLowerCase();
  return status !== "collectfail" && status !== "fail" && !(item.reason ?? "").trim();
}

function decimalToMinor(value: string | number): string {
  const text = String(value).trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) {
    throw externalFailure("fatal", "miaoshou.invalid_price", "Miaoshou returned an invalid price");
  }
  const negative = text.startsWith("-");
  const unsigned = negative ? text.slice(1) : text;
  const [whole = "0", fraction = ""] = unsigned.split(".");
  const minor = BigInt(whole) * 100n + BigInt((fraction + "00").slice(0, 2));
  return `${negative ? "-" : ""}${minor}`;
}

function skuAttributes(
  key: string,
  colorPropName?: string,
  sizePropName?: string,
  thirdPropName?: string
): Record<string, string> {
  const values = key.split(";").map((part) => part.trim()).filter(Boolean);
  const names = [colorPropName, sizePropName, thirdPropName].filter(
    (name): name is string => Boolean(name)
  );
  return Object.fromEntries(values.map((value, index) => [names[index] ?? `规格${index + 1}`, value]));
}

function mapDetail(raw: RawDetail): MiaoshouCollectedDetail {
  const source = (raw.sourceList ?? []).find((item) => item.sourceItemId);
  const sourceItemId = String(source?.sourceItemId ?? "");
  if (!sourceItemId) {
    throw externalFailure("retryable", "miaoshou.detail_pending", "Miaoshou detail is not ready yet");
  }
  const price = raw.price;
  const dimensions = [raw.packageLength, raw.packageWidth, raw.packageHeight];
  const hasDimensions = dimensions.every(
    (value) => value !== null && value !== undefined && String(value).trim() !== ""
  );
  return Object.freeze({
    detailId: String(raw.commonCollectBoxDetailId),
    sourceItemId: toSourceItemId(sourceItemId),
    sourceUrl: `https://detail.1688.com/offer/${sourceItemId}.html`,
    title: raw.title ?? "",
    itemNumber: raw.itemNum ?? null,
    description: raw.notesText ?? raw.notes ?? "",
    category: raw.cateList?.join(" > ") || null,
    sourcePriceWire:
      price === null || price === undefined
        ? null
        : { amountMinor: decimalToMinor(price), currency: "CNY" as const },
    sourceStock: raw.stock ?? null,
    weightKg:
      raw.weight === null || raw.weight === undefined ? null : String(raw.weight),
    dimensionsCm: hasDimensions
      ? {
          lengthCm: String(raw.packageLength),
          widthCm: String(raw.packageWidth),
          heightCm: String(raw.packageHeight)
        }
      : null,
    mainImages: (raw.imgUrls ?? []).map((url) => ({ url, width: 0, height: 0 })),
    detailImages: [],
    sourceAttributes: raw.sourceAttrs ?? [],
    saleAttributes: [
      raw.colorPropName
        ? { name: raw.colorPropName, value: Object.keys(raw.colorMap ?? {}).join(",") }
        : null,
      raw.sizePropName
        ? { name: raw.sizePropName, value: Object.keys(raw.sizeMap ?? {}).join(",") }
        : null
    ].filter((item): item is { name: string; value: string } => item !== null),
    colors: Object.keys(raw.colorMap ?? {}),
    sizes: Object.keys(raw.sizeMap ?? {}),
    skus: Object.entries(raw.skuMap ?? {}).map(([key, sku]) => ({
      skuId: sku.itemNum || key,
      attributes: skuAttributes(key, raw.colorPropName, raw.sizePropName, raw.saleProp3Name),
      priceWire: {
        amountMinor: decimalToMinor(sku.price ?? raw.price ?? 0),
        currency: "CNY" as const
      },
      stock: sku.stock ?? null,
      imageUrl: sku.imageUrl ?? sku.imgUrl ?? null
    }))
  });
}

export function createMiaoshouSourceAdapter(deps: SourceAdapterDeps): MiaoshouSourceAdapter {
  const { http } = deps;

  async function listRecords(sourceItemId: SourceItemId): Promise<CollectBoxListItem[]> {
    const response = await http.post<ApiEnvelope<CollectBoxListData>>(LIST_PATH, {
      pageNo: 1,
      pageSize: 20,
      filter: { tabPaneName: "all", sourceItemIdKeyword: sourceItemId }
    });
    return (requireSuccess(response, "miaoshou.list_failed").detailList ?? []).filter((item) =>
      isSource(item, sourceItemId)
    );
  }

  async function fetchDetail(detailId: string): Promise<MiaoshouCollectedDetail> {
    const response = await http.post<ApiEnvelope<DetailData>>(DETAIL_PATH, {
      commonCollectBoxDetailId: Number(detailId)
    });
    const raw = requireSuccess(response, "miaoshou.detail_failed").editCommonCollectBoxDetail;
    if (!raw) {
      throw externalFailure("retryable", "miaoshou.detail_pending", "Miaoshou detail is not ready yet");
    }
    return mapDetail(raw);
  }

  async function resolveCanonicalSuccess(sourceItemId: SourceItemId) {
    const records = await listRecords(sourceItemId);
    const canonical = records
      .filter(isUsable)
      .sort((a, b) => (b.gmtModified ?? "").localeCompare(a.gmtModified ?? ""))[0];
    if (!canonical) {
      throw externalFailure("retryable", "miaoshou.detail_pending", "Miaoshou detail is not ready yet");
    }
    const canonicalSuccessDetailId = String(canonical.commonCollectBoxDetailId);
    return {
      canonicalSuccessDetailId,
      detail: await fetchDetail(canonicalSuccessDetailId)
    };
  }

  return {
    async fetchItem({ sourceUrl }) {
      let normalized;
      try {
        normalized = normalize1688OfferUrl(sourceUrl);
      } catch {
        throw externalFailure(
          "needs_input",
          "miaoshou.invalid_source_url",
          "Please provide a 1688 product detail URL"
        );
      }
      const response = await http.post<ApiEnvelope<FetchItemData>>(FETCH_ITEM_PATH, {
        collectLinks: [normalized.canonicalUrl]
      });
      const data = requireSuccess(response, "miaoshou.fetch_failed");
      const mappedId = data.sourceItemIdAndDetailIdMap?.[normalized.sourceItemId];
      if (mappedId === null || mappedId === undefined) {
        throw externalFailure("retryable", "miaoshou.detail_pending", "Miaoshou detail is not ready yet");
      }
      const fetchDetailId = String(mappedId);
      const sid = toSourceItemId(normalized.sourceItemId);
      const resolved = await resolveCanonicalSuccess(sid);
      const skippedDetailId =
        fetchDetailId === resolved.canonicalSuccessDetailId ? null : fetchDetailId;
      return {
        fetchDetailId,
        skippedDetailId,
        canonicalSuccessDetailId: resolved.canonicalSuccessDetailId,
        detail: resolved.detail
      };
    },
    async resolveCanonicalSuccessDetail({ sourceItemId }) {
      return resolveCanonicalSuccess(sourceItemId);
    },
    summarize(result) {
      const detail = result.detail;
      const warnings: CollectionWarningCode[] = [];
      if (!detail.title) warnings.push(CollectionWarningCodes.MissingTitle);
      if (!detail.sourcePriceWire) warnings.push(CollectionWarningCodes.MissingSourcePrice);
      if (detail.skus.length === 0) warnings.push(CollectionWarningCodes.MissingSku);
      if (!detail.weightKg) warnings.push(CollectionWarningCodes.MissingWeight);
      if (!detail.dimensionsCm) warnings.push(CollectionWarningCodes.MissingDimensions);
      warnings.push(CollectionWarningCodes.MissingSizeChart);
      warnings.push(CollectionWarningCodes.MissingVideo);
      warnings.push(CollectionWarningCodes.MissingCertification);
      const status: SourceSummary["status"] =
        detail.mainImages.length === 0 ? "invalid" : warnings.length === 0 ? "ok" : "partial";
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
