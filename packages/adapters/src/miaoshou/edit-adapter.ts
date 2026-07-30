import {
  externalFailure,
  reconcileRequiredFailure,
  type ExternalFailure,
  type MiaoshouEditFieldError,
  type MiaoshouEditPort
} from "@tk/contracts";
import type { MiaoshouConfig, MiaoshouHttp } from "./client.js";
import { createMiaoshouHttp } from "./client.js";
import { mapApprovalSnapshotToMiaoshouEdit, type MiaoshouEditableDetail } from "./edit-mapper.js";
import { detailIdWire, fingerprintMiaoshouEditableDetail, readCanonicalDetail, reconcileMiaoshouEdit, type MiaoshouEditExpectation } from "./reconcile-edit.js";

const EDIT_PATH = "/open/v1/product/common_collect_box/common_collect_box/edit_common_collect_box_detail";

type ApiEnvelope = {
  result?: string;
  code?: string | number;
  message?: string;
  data?: { fieldErrors?: Array<{ field?: string; fieldPath?: string; message?: string }> };
};

export interface MiaoshouEditAdapterDeps {
  readonly http: MiaoshouHttp;
  readonly expectationResolver?: MiaoshouEditExpectationResolver;
}

export interface MiaoshouEditExpectationResolver {
  resolve(input: {
    canonicalSuccessDetailId: string;
    sourceItemId: string;
  }): Promise<MiaoshouEditExpectation | undefined>;
}

function validExpectation(value: MiaoshouEditExpectation | undefined): value is MiaoshouEditExpectation {
  return Boolean(value
    && value.version === 1
    && typeof value.title === "string"
    && typeof value.notesText === "string"
    && typeof value.notes === "string"
    && Array.isArray(value.imgUrlSha256)
    && Array.isArray(value.sourceAttrs));
}

function failureLike(error: unknown): error is ExternalFailure {
  if (!error || typeof error !== "object") return false;
  const value = error as Partial<ExternalFailure>;
  return typeof value.kind === "string" && typeof value.code === "string" && typeof value.safeMessage === "string";
}

function stableFieldPath(field: string): string {
  const normalized = field.trim().replace(/^editCommonCollectBoxDetail\.?/, "");
  const dimensionPaths: Record<string, string> = {
    packageLength: "dimensions.lengthCm",
    packageWidth: "dimensions.widthCm",
    packageHeight: "dimensions.heightCm",
    price: "priceWire.amountMinor",
    weight: "weightKg",
    imgUrls: "orderedFinalAssetIds",
    notes: "description",
    notesText: "description",
    sourceAttrs: "attributes"
  };
  if (dimensionPaths[normalized]) return dimensionPaths[normalized]!;
  const sku = normalized.match(/^skuMap\.([^.]*)\.(.+)$/);
  if (sku) {
    const leaf = sku[2] === "price" ? "priceWire.amountMinor" : sku[2];
    return `skus.${sku[1] || "unknown"}.${leaf}`;
  }
  return /^[A-Za-z][A-Za-z0-9_.-]*$/.test(normalized) ? normalized : "product";
}

function validationErrors(response: ApiEnvelope): MiaoshouEditFieldError[] {
  const errors = response.data?.fieldErrors ?? [];
  if (errors.length > 0) {
    return errors.map((error) => ({
      fieldPath: stableFieldPath(error.fieldPath ?? error.field ?? "product"),
      message: (error.message ?? "字段校验失败").slice(0, 200)
    }));
  }
  if (/validation|invalid|required|missing/i.test(String(response.code ?? ""))) {
    return [{ fieldPath: "product", message: "商品字段未通过妙手校验" }];
  }
  return [];
}

function hasUnknownWriteResult(response: ApiEnvelope): boolean {
  const code = String(response.code ?? "").toLowerCase();
  return new Set(["timeout", "requesttimeout", "gatewaytimeout", "systembusy", "systemerror", "internalerror", "unknown"]).has(code)
    || /^5\d\d$/.test(code);
}

function unknownWriteResult(desired: MiaoshouEditableDetail) {
  return {
    desired,
    result: {
      kind: "needs_reconcile" as const,
      failure: reconcileRequiredFailure("miaoshou.edit_result_unknown", "Miaoshou edit result is unknown and must be reconciled"),
      remoteTaskId: null
    }
  };
}

function limitMiaoshouCollection(value: unknown, maxItems = 50): unknown {
  if (Array.isArray(value)) return value.slice(0, maxItems);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, maxItems));
  }
  return value;
}

function collectionKeys(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => {
      if (item && typeof item === "object") {
        const record = item as Record<string, unknown>;
        const name = record.name ?? record.value ?? record.label;
        if (typeof name === "string" && name.trim()) return [name];
      }
      return [String(index)];
    });
  }
  if (value && typeof value === "object") return Object.keys(value as Record<string, unknown>);
  return [];
}

function skuDimensionValues(skuMapKey: string): string[] {
  const semicolonParts = skuMapKey.split(";").filter(Boolean);
  return semicolonParts.length > 0 ? semicolonParts : [skuMapKey];
}

function filterSkuMapBySaleProperties(input: {
  skuMap: unknown;
  colorMap: unknown;
  sizeMap: unknown;
  saleProp3Map: unknown;
}): unknown {
  if (!input.skuMap || typeof input.skuMap !== "object" || Array.isArray(input.skuMap)) return input.skuMap;
  const skuMap = input.skuMap as Record<string, unknown>;
  const dimensions = [
    collectionKeys(input.colorMap),
    collectionKeys(input.sizeMap),
    collectionKeys(input.saleProp3Map)
  ].map((keys) => new Set(keys));
  if (dimensions.every((keys) => keys.size === 0)) return skuMap;

  return Object.fromEntries(Object.entries(skuMap).filter(([key]) => {
    const values = skuDimensionValues(key);
    return dimensions.every((allowed, index) => allowed.size === 0 || !values[index] || allowed.has(values[index]!));
  }));
}

function mergeDetail(current: Record<string, unknown>, desired: MiaoshouEditableDetail): Record<string, unknown> {
  const colorMap = limitMiaoshouCollection(current.colorMap);
  const sizeMap = limitMiaoshouCollection(current.sizeMap);
  const saleProp3Map = limitMiaoshouCollection(current.saleProp3Map);
  const skuMap = filterSkuMapBySaleProperties({ skuMap: current.skuMap, colorMap, sizeMap, saleProp3Map });
  const merged: Record<string, unknown> = {
    ...current,
    ...desired,
    colorMap,
    sizeMap,
    saleProp3Map,
    ...(skuMap === undefined ? {} : { skuMap })
  };
  return merged;
}

export function createMiaoshouEditAdapter(deps: MiaoshouEditAdapterDeps): MiaoshouEditPort {
  const pending = new Map<string, MiaoshouEditExpectation>();
  return {
    async applyEdit({ approvalSnapshot, orderedRemoteAssetUrls }) {
      const canonicalId = String(approvalSnapshot.canonicalSuccessDetailId);
      if (pending.has(canonicalId)) {
        return {
          kind: "needs_reconcile",
          failure: reconcileRequiredFailure("miaoshou.edit_reconciliation_pending", "Reconcile the previous Miaoshou edit before retrying"),
          remoteTaskId: null
        };
      }

      const desired = mapApprovalSnapshotToMiaoshouEdit(approvalSnapshot, orderedRemoteAssetUrls);
      const detailData = await readCanonicalDetail(deps.http, canonicalId);
      if (!detailData?.editCommonCollectBoxDetail) {
        throw externalFailure("needs_input", "miaoshou.canonical_detail_missing", "The canonical Miaoshou collect-box product no longer exists");
      }
      const body = {
        commonCollectBoxDetailId: detailIdWire(canonicalId),
        editCommonCollectBoxDetail: mergeDetail(detailData.editCommonCollectBoxDetail, desired),
        ossMd5: detailData.ossMd5 ?? ""
      };

      let response: ApiEnvelope;
      try {
        response = await deps.http.post<ApiEnvelope>(EDIT_PATH, body);
      } catch (error) {
        if (failureLike(error) && error.kind !== "retryable" && error.kind !== "reconcile_required") throw error;
        const unknown = unknownWriteResult(desired);
        pending.set(canonicalId, fingerprintMiaoshouEditableDetail(unknown.desired));
        return unknown.result;
      }

      if (response.result === "success") {
        return { kind: "succeeded", remoteDetailId: canonicalId };
      }
      if (hasUnknownWriteResult(response)) {
        const unknown = unknownWriteResult(desired);
        pending.set(canonicalId, fingerprintMiaoshouEditableDetail(unknown.desired));
        return unknown.result;
      }
      const fieldErrors = validationErrors(response);
      if (fieldErrors.length > 0) return { kind: "validation_failed", fieldErrors };
      const code = String(response.code ?? "edit_failed");
      throw externalFailure(
        /sign|permission|whitelist|appNotFound/i.test(code) ? "needs_input" : "fatal",
        `miaoshou.${code}`,
        "Miaoshou rejected the common collect-box edit"
      );
    },

    async reconcileByCanonicalDetailId({ canonicalSuccessDetailId, sourceItemId }) {
      const resolved = pending.get(canonicalSuccessDetailId)
        ?? await deps.expectationResolver?.resolve({ canonicalSuccessDetailId, sourceItemId: String(sourceItemId) });
      const expectedDetail = validExpectation(resolved) ? resolved : undefined;
      const result = await reconcileMiaoshouEdit({
        http: deps.http,
        canonicalSuccessDetailId,
        sourceItemId,
        expectedDetail
      });
      if (result.state === "applied") pending.delete(canonicalSuccessDetailId);
      return result;
    }
  };
}

export function createLiveMiaoshouEditAdapter(config: MiaoshouConfig, fetchImpl?: typeof fetch): MiaoshouEditPort {
  return createMiaoshouEditAdapter({ http: createMiaoshouHttp(config, fetchImpl) });
}
