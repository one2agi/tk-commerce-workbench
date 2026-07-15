import { externalFailure, type SourceItemId } from "@tk/contracts";
import type { MiaoshouHttp } from "./client.js";
import type { MiaoshouEditableDetail } from "./edit-mapper.js";

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
  expectedDetail?: MiaoshouEditableDetail;
}): Promise<{ remoteDetailId: string; state: "applied" | "no_change" | "missing" }> {
  const data = await readCanonicalDetail(input.http, input.canonicalSuccessDetailId);
  const detail = data?.editCommonCollectBoxDetail;
  if (!detail) return { remoteDetailId: input.canonicalSuccessDetailId, state: "missing" };

  const canonicalMatches = String(detail.commonCollectBoxDetailId ?? input.canonicalSuccessDetailId) === input.canonicalSuccessDetailId;
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

function remoteMatchesExpected(remote: Record<string, unknown>, expected: MiaoshouEditableDetail): boolean {
  const scalarPairs: Array<[unknown, unknown]> = [
    [remote.title, expected.title],
    [remote.notesText, expected.notesText],
    [remote.notes, expected.notes],
    [remote.price, expected.price],
    [remote.stock, expected.stock],
    [remote.weight, expected.weight]
  ];
  if (expected.itemNum !== undefined) scalarPairs.push([remote.itemNum, expected.itemNum]);
  if (expected.packageLength !== undefined) scalarPairs.push([remote.packageLength, expected.packageLength]);
  if (expected.packageWidth !== undefined) scalarPairs.push([remote.packageWidth, expected.packageWidth]);
  if (expected.packageHeight !== undefined) scalarPairs.push([remote.packageHeight, expected.packageHeight]);
  if (scalarPairs.some(([actual, wanted]) => String(actual) !== String(wanted))) return false;
  if (JSON.stringify(remote.imgUrls ?? []) !== JSON.stringify(expected.imgUrls)) return false;
  if (JSON.stringify(remote.sourceAttrs ?? []) !== JSON.stringify(expected.sourceAttrs)) return false;

  const remoteSkus = remote.skuMap && typeof remote.skuMap === "object"
    ? remote.skuMap as Record<string, Record<string, unknown>>
    : {};
  return Object.entries(expected.skuMap).every(([skuId, wanted]) => {
    const actual = Object.values(remoteSkus).find((sku) => String(sku.itemNum ?? "") === skuId) ?? remoteSkus[skuId];
    return actual
      && String(actual.price) === String(wanted.price)
      && String(actual.stock) === String(wanted.stock)
      && String(actual.weight) === String(wanted.weight)
      && String(actual.imgUrl ?? "") === String(wanted.imgUrl ?? "")
      && JSON.stringify(actual.attributes ?? {}) === JSON.stringify(wanted.attributes);
  });
}
