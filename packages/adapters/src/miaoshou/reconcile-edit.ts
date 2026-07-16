import { externalFailure, type ApprovalSnapshotV1, type SourceItemId } from "@tk/contracts";
import { createHash } from "node:crypto";
import type { MiaoshouHttp } from "./client.js";
import { mapApprovalSnapshotToMiaoshouEdit, type MiaoshouEditableDetail } from "./edit-mapper.js";

export type MiaoshouEditExpectation = Readonly<{
  version: 1;
  title: string;
  itemNum?: string;
  notesText: string;
  notes: string;
  price: number;
  stock: number;
  weight: number;
  packageLength?: number;
  packageWidth?: number;
  packageHeight?: number;
  imgUrlSha256: readonly string[];
  sourceAttrs: MiaoshouEditableDetail["sourceAttrs"];
  skuMap: Readonly<Record<string, Readonly<{
    itemNum: string;
    price: number;
    stock: number;
    weight: number;
    imgUrlSha256?: string;
  }>>>;
}>;

export type MiaoshouExactObservableProjection = Readonly<{
  title: string;
  itemNum?: string;
  notesText: string;
  notes: string;
  price: number;
  stock: number;
  weight: number;
  packageLength?: number;
  packageWidth?: number;
  packageHeight?: number;
  imgUrlSha256: readonly string[];
  sourceAttrs: MiaoshouEditableDetail["sourceAttrs"];
  skuMap: Readonly<Record<string, Readonly<{ price: number; stock: number }>>>;
}>;

/** Fields the verified Miaoshou GET detail endpoint actually echoes after edit. */
export function exactObservableProjection(expected: MiaoshouEditExpectation): MiaoshouExactObservableProjection {
  return Object.freeze({
    title: expected.title,
    ...(expected.itemNum === undefined ? {} : { itemNum: expected.itemNum }),
    notesText: expected.notesText,
    notes: expected.notes,
    price: expected.price,
    stock: expected.stock,
    weight: expected.weight,
    ...(expected.packageLength === undefined ? {} : { packageLength: expected.packageLength }),
    ...(expected.packageWidth === undefined ? {} : { packageWidth: expected.packageWidth }),
    ...(expected.packageHeight === undefined ? {} : { packageHeight: expected.packageHeight }),
    imgUrlSha256: expected.imgUrlSha256,
    sourceAttrs: expected.sourceAttrs,
    skuMap: Object.freeze(Object.fromEntries(Object.entries(expected.skuMap).map(([key, sku]) => [key, Object.freeze({
      price: sku.price,
      stock: sku.stock
    })])))
  });
}

export function sha256Text(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export function stableDigest(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(Object.entries(candidate as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalize(item)]));
    }
    return candidate;
  };
  return sha256Text(JSON.stringify(normalize(value)));
}

export function fingerprintMiaoshouEditableDetail(detail: MiaoshouEditableDetail): MiaoshouEditExpectation {
  return Object.freeze({
    version: 1,
    title: detail.title,
    ...(detail.itemNum === undefined ? {} : { itemNum: detail.itemNum }),
    notesText: detail.notesText,
    notes: detail.notes,
    price: detail.price,
    stock: detail.stock,
    weight: detail.weight,
    ...(detail.packageLength === undefined ? {} : { packageLength: detail.packageLength }),
    ...(detail.packageWidth === undefined ? {} : { packageWidth: detail.packageWidth }),
    ...(detail.packageHeight === undefined ? {} : { packageHeight: detail.packageHeight }),
    imgUrlSha256: Object.freeze(detail.imgUrls.map(sha256Text)),
    sourceAttrs: detail.sourceAttrs,
    skuMap: Object.freeze(Object.fromEntries(Object.entries(detail.skuMap).map(([key, sku]) => [key, Object.freeze({
      itemNum: sku.itemNum,
      price: sku.price,
      stock: sku.stock,
      weight: sku.weight,
      ...(sku.imgUrl ? { imgUrlSha256: sha256Text(sku.imgUrl) } : {})
    })])))
  });
}

export function fingerprintApprovalSnapshot(
  snapshot: ApprovalSnapshotV1,
  orderedRemoteAssetUrlSha256: readonly string[]
): MiaoshouEditExpectation {
  if (orderedRemoteAssetUrlSha256.length !== snapshot.orderedFinalAssetIds.length
    || orderedRemoteAssetUrlSha256.some((hash) => !/^[a-f0-9]{64}$/.test(hash))) {
    throw new Error("invalid ordered staging URL fingerprints");
  }
  const placeholders = orderedRemoteAssetUrlSha256.map((hash) => `https://fingerprint.invalid/${hash}`);
  const base = fingerprintMiaoshouEditableDetail(mapApprovalSnapshotToMiaoshouEdit(snapshot, placeholders));
  const hashByAsset = new Map(snapshot.orderedFinalAssetIds.map((id, index) => [String(id), orderedRemoteAssetUrlSha256[index]!]));
  const skuMap = Object.fromEntries(Object.entries(base.skuMap).map(([key, sku]) => {
    const sourceSku = snapshot.skus.find((candidate) => {
      const values = Object.values(candidate.attributes);
      return `;${(values.length > 0 ? values : [candidate.skuId]).join(";")};` === key;
    });
    const imageHash = sourceSku?.assetIds.map((id) => hashByAsset.get(String(id))).find(Boolean);
    return [key, Object.freeze({ ...sku, ...(imageHash ? { imgUrlSha256: imageHash } : {}) })];
  }));
  return Object.freeze({ ...base, imgUrlSha256: Object.freeze([...orderedRemoteAssetUrlSha256]), skuMap: Object.freeze(skuMap) });
}

export const MIAOSHOU_DETAIL_PATH = "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail";

type DetailEnvelope = {
  result?: string;
  code?: string | number;
  data?: {
    editCommonCollectBoxDetail?: {
      commonCollectBoxDetailId?: string | number;
      itemNum?: string | null;
      sourceList?: Array<{ sourceItemId?: string | number | null }>;
      [key: string]: unknown;
    };
    ossMd5?: string;
  };
};

export function detailIdWire(detailId: string): string | number {
  if (/^\d+$/.test(detailId)) {
    const value = Number(detailId);
    if (Number.isSafeInteger(value)) return value;
  }
  return detailId;
}

export async function readCanonicalDetail(http: MiaoshouHttp, canonicalSuccessDetailId: string): Promise<DetailEnvelope["data"]> {
  const response = await http.post<DetailEnvelope>(MIAOSHOU_DETAIL_PATH, {
    commonCollectBoxDetailId: detailIdWire(canonicalSuccessDetailId)
  });
  if (response.result !== "success" || !response.data?.editCommonCollectBoxDetail) {
    const code = String(response.code ?? "detail_missing");
    if (/not.?found|missing|empty|no.?data/i.test(code)) return undefined;
    throw externalFailure("retryable", `miaoshou.${code}`, "Miaoshou detail could not be reconciled");
  }
  return response.data;
}

export async function reconcileMiaoshouEdit(input: {
  http: MiaoshouHttp;
  canonicalSuccessDetailId: string;
  sourceItemId: SourceItemId;
  expectedDetail?: MiaoshouEditExpectation;
}): Promise<{ remoteDetailId: string; state: "applied" | "no_change" | "missing" }> {
  const data = await readCanonicalDetail(input.http, input.canonicalSuccessDetailId);
  const detail = data?.editCommonCollectBoxDetail;
  if (!detail) return { remoteDetailId: input.canonicalSuccessDetailId, state: "missing" };

  const canonicalMatches = detail.commonCollectBoxDetailId !== undefined
    && String(detail.commonCollectBoxDetailId) === input.canonicalSuccessDetailId;
  const sourceMatches = (detail.sourceList ?? []).some((source) => String(source.sourceItemId ?? "") === String(input.sourceItemId));
  if (!canonicalMatches || !sourceMatches) {
    return { remoteDetailId: input.canonicalSuccessDetailId, state: "missing" };
  }
  // After a process restart the frozen port gives reconciliation only the
  // canonical/source IDs, not the immutable desired snapshot. Existing remote
  // identity is not proof that the write landed, so fail closed as no_change.
  if (!input.expectedDetail || !remoteMatchesExpected(detail, input.expectedDetail)) {
    return { remoteDetailId: input.canonicalSuccessDetailId, state: "no_change" };
  }
  return { remoteDetailId: input.canonicalSuccessDetailId, state: "applied" };
}

function remoteMatchesExpected(remote: Record<string, unknown>, expected: MiaoshouEditExpectation): boolean {
  const observable = exactObservableProjection(expected);
  const scalarPairs: Array<[unknown, unknown]> = [
    [remote.title, observable.title],
    [remote.notesText, observable.notesText],
    [remote.notes, observable.notes],
    [remote.price, observable.price],
    [remote.stock, observable.stock],
    [remote.weight, observable.weight]
  ];
  if (observable.itemNum !== undefined) scalarPairs.push([remote.itemNum, observable.itemNum]);
  if (observable.packageLength !== undefined) scalarPairs.push([remote.packageLength, observable.packageLength]);
  if (observable.packageWidth !== undefined) scalarPairs.push([remote.packageWidth, observable.packageWidth]);
  if (observable.packageHeight !== undefined) scalarPairs.push([remote.packageHeight, observable.packageHeight]);
  if (scalarPairs.some(([actual, wanted]) => String(actual) !== String(wanted))) return false;
  const remoteImageHashes = Array.isArray(remote.imgUrls) && remote.imgUrls.every((url) => typeof url === "string")
    ? remote.imgUrls.map((url) => sha256Text(String(url)))
    : [];
  if (JSON.stringify(remoteImageHashes) !== JSON.stringify(observable.imgUrlSha256)) return false;
  if (JSON.stringify(remote.sourceAttrs ?? []) !== JSON.stringify(observable.sourceAttrs)) return false;

  const remoteSkus = remote.skuMap && typeof remote.skuMap === "object"
    ? remote.skuMap as Record<string, Record<string, unknown>>
    : {};
  const expectedKeys = Object.keys(observable.skuMap).sort();
  if (JSON.stringify(Object.keys(remoteSkus).sort()) !== JSON.stringify(expectedKeys)) return false;
  return Object.entries(observable.skuMap).every(([dimensionKey, wanted]) => {
    const actual = remoteSkus[dimensionKey];
    return actual
      && String(actual.price) === String(wanted.price)
      && String(actual.stock) === String(wanted.stock);
  });
}
