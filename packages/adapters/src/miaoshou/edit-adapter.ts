import {
  externalFailure,
  reconcileRequiredFailure,
  type ExternalFailure,
  type MiaoshouEditFieldError,
  type MiaoshouEditPort
} from "@tk/contracts";
import type { MiaoshouConfig, MiaoshouHttp } from "./client.js";
import { createMiaoshouHttp } from "./client.js";
import { mapApprovalSnapshotToMiaoshouEdit, type MiaoshouEditableDetail, type MiaoshouEditableSku } from "./edit-mapper.js";
import { detailIdWire, readCanonicalDetail, reconcileMiaoshouEdit } from "./reconcile-edit.js";

const EDIT_PATH = "/open/v1/product/common_collect_box/common_collect_box/edit_common_collect_box_detail";

type ApiEnvelope = {
  result?: string;
  code?: string | number;
  message?: string;
  data?: { fieldErrors?: Array<{ field?: string; fieldPath?: string; message?: string }> };
};

export interface MiaoshouEditAdapterDeps {
  readonly http: MiaoshouHttp;
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

function mergeSkuMap(current: unknown, desired: MiaoshouEditableDetail["skuMap"]): Record<string, unknown> {
  const currentMap = current && typeof current === "object" ? current as Record<string, Record<string, unknown>> : {};
  const merged: Record<string, unknown> = {};
  for (const [skuId, wanted] of Object.entries(desired)) {
    const remote = Object.entries(currentMap).find(([key, value]) => key === skuId || String(value?.itemNum ?? "") === skuId);
    const key = remote?.[0] ?? skuId;
    const existing = remote?.[1] ?? {};
    merged[key] = { ...existing, ...wanted } satisfies MiaoshouEditableSku;
  }
  return merged;
}

function mergeDetail(current: Record<string, unknown>, desired: MiaoshouEditableDetail): Record<string, unknown> {
  return {
    ...current,
    ...desired,
    skuMap: mergeSkuMap(current.skuMap, desired.skuMap)
  };
}

export function createMiaoshouEditAdapter(deps: MiaoshouEditAdapterDeps): MiaoshouEditPort {
  const pending = new Map<string, MiaoshouEditableDetail>();
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
        pending.set(canonicalId, desired);
        return {
          kind: "needs_reconcile",
          failure: reconcileRequiredFailure("miaoshou.edit_result_unknown", "Miaoshou edit result is unknown and must be reconciled"),
          remoteTaskId: null
        };
      }

      if (response.result === "success") {
        return { kind: "succeeded", remoteDetailId: canonicalId };
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
      const expectedDetail = pending.get(canonicalSuccessDetailId);
      const result = await reconcileMiaoshouEdit({
        http: deps.http,
        canonicalSuccessDetailId,
        sourceItemId,
        expectedDetail
      });
      pending.delete(canonicalSuccessDetailId);
      return result;
    }
  };
}

export function createLiveMiaoshouEditAdapter(config: MiaoshouConfig, fetchImpl?: typeof fetch): MiaoshouEditPort {
  return createMiaoshouEditAdapter({ http: createMiaoshouHttp(config, fetchImpl) });
}
