import type { ProductPoolItemV1 } from "@tk/contracts/read-models";
import { projectUiStage } from "@tk/domain/state/project-ui-stage";

import type { StartStatus } from "./product-workbench.state";

export type ProductBusinessStage =
  | "pending"
  | "processing"
  | "review"
  | "needs_attention"
  | "synced";

export type WorkbenchStageKey = "all" | ProductBusinessStage;

export const STAGE_ORDER: ReadonlyArray<WorkbenchStageKey> = [
  "all",
  "pending",
  "processing",
  "review",
  "needs_attention",
  "synced"
];

export const STAGE_LABELS: Readonly<Record<WorkbenchStageKey, string>> = {
  all: "全部",
  pending: "待处理",
  processing: "自动处理中",
  review: "待确认",
  needs_attention: "需要人工处理",
  synced: "已完成"
};

type ProductPoolUiFields = Readonly<{
  sourceUrl?: string;
  thumbnailUrl?: string | null;
  collectedAt?: string;
  updatedAt?: string;
}>;

export type RowAction =
  | Readonly<{ kind: "start"; label: "开始处理" | "处理中" | "已开始" | "重试处理"; enabled: boolean }>
  | Readonly<{ kind: "review"; label: "查看并确认"; enabled: true; href: string }>
  | Readonly<{ kind: "progress"; label: "查看进度"; enabled: true; href: string }>
  | Readonly<{ kind: "record"; label: "查看记录"; enabled: true; href: string }>
  | Readonly<{ kind: "issue"; label: "查看原因" | "重试"; enabled: true; href: string }>;

export type ProductRowView = Readonly<{
  productId: string;
  revisionId: string;
  thumbnailUrl: string | null;
  title: string;
  sourceLabel: string;
  sourceUrl: string | null;
  collectedAtLabel: string;
  businessStage: ProductBusinessStage;
  businessStatusLabel: string;
  imageProgressLabel: string;
  issueLabel: string | null;
  nextAction: RowAction;
  canBatchStart: boolean;
  canBatchConfirm: boolean;
  canBatchRetry: boolean;
}>;

export function productBusinessStage(item: ProductPoolItemV1): ProductBusinessStage {
  if (
    item.miaoshouSource === "local_captured"
    && item.sourceCaptureQuality !== "detail_page_complete"
  ) {
    return "needs_attention";
  }
  return projectUiStage({
    miaoshouSource: item.miaoshouSource,
    automation: item.automation,
    assetArchive: item.assetArchive,
    listing: item.listing,
    canvas: item.canvas,
    approval: item.approval,
    miaoshouEdit: item.miaoshouEdit,
    hasUsableCanvasOutputs: item.usableCanvasOutputCount > 0
  }).label;
}

export function canStartProcessing(item: ProductPoolItemV1): boolean {
  return (
    item.automation === "not_started" &&
    (
      item.miaoshouSource === "local_captured"
      || item.miaoshouSource === "success"
      || item.miaoshouSource === "skipped_duplicate"
    ) &&
    (
      item.miaoshouSource !== "local_captured"
      || item.sourceCaptureQuality === "detail_page_complete"
    ) &&
    item.sourceImageCount > 0
  );
}

export function buildImageProgress(item: ProductPoolItemV1): string {
  const count = `主图 ${Math.min(item.usableCanvasOutputCount, 5)}/5`;
  if (item.automation === "needs_input" || item.listing === "needs_input") return `等待补充信息 · ${count}`;
  if (item.canvas === "queued") return `Canvas 排队中 · ${count}`;
  if (item.canvas === "running") return `Canvas 生图中 · ${count}`;
  if (item.canvas === "failed") return `Canvas 失败 · ${count}`;
  if (
    item.canvas === "not_started" &&
    (item.automation === "queued" || item.automation === "running" || item.automation === "paused" || item.automation === "ready")
  ) {
    return `等待 Canvas · ${count}`;
  }
  return count;
}

export function buildProductIssue(item: ProductPoolItemV1): string | null {
  if (
    item.miaoshouSource === "local_captured"
    && item.sourceCaptureQuality !== "detail_page_complete"
  ) {
    return "本地采集不完整，请重新采集";
  }
  if (item.sourceImageCount <= 0) return "1688 详情数据没有可用图片";
  if (item.canvas === "partial" && item.usableCanvasOutputCount <= 0) return "Canvas 没有返回可用图片";
  if (item.canvas === "failed") return "Canvas 生图失败，请查看原因或重试";
  if (item.miaoshouEdit === "result_unknown") return "妙手写回结果未知，需要人工对账";
  if (item.assetArchive === "failed") return "图片归档失败，请重试";
  if (item.listing === "failed" || item.listing === "needs_input") return "标题或 Listing 生成失败，请查看原因";
  if (item.approval === "invalidated") return "商品内容已修改，需要重新确认";
  if (item.miaoshouSource === "failed") return "妙手采集失败，请重新采集";
  if (item.warningCodes.includes("reconcile_required") && item.approval === "approved") {
    return "妙手导入结果未知，需要在采集箱核对";
  }
  if (item.warningCodes.includes("missing_weight") && item.listing === "ready") return "旧任务停在已移除的定价节点，点击重试继续生图";
  return item.warningCodes[0] ?? null;
}

function formatDate(value: string | undefined): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "—";
  return date.toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Asia/Shanghai"
  });
}

export function buildProductRowView(
  item: ProductPoolItemV1,
  startStatus: StartStatus = "idle"
): ProductRowView {
  const productId = String(item.productId);
  const ui = item as ProductPoolItemV1 & ProductPoolUiFields;
  const stage = productBusinessStage(item);
  const optimisticProcessing = stage === "pending" && (startStatus === "pending" || startStatus === "success");
  const effectiveStage = optimisticProcessing ? "processing" : stage;
  const issue = buildProductIssue(item);
  const href = `/products/${encodeURIComponent(productId)}`;
  const startable = canStartProcessing(item);
  const nextAction: RowAction =
    effectiveStage === "review"
      ? { kind: "review", label: "查看并确认", enabled: true, href }
      : effectiveStage === "processing"
        ? { kind: "progress", label: "查看进度", enabled: true, href }
        : effectiveStage === "synced"
          ? { kind: "record", label: "查看记录", enabled: true, href: `/write-records?productId=${encodeURIComponent(productId)}` }
          : effectiveStage === "needs_attention"
            ? { kind: "issue", label: issue?.includes("失败") ? "重试" : "查看原因", enabled: true, href }
            : {
                kind: "start",
                label: startStatus === "pending"
                  ? "处理中"
                  : startStatus === "success"
                    ? "已开始"
                    : startStatus === "failure"
                      ? "重试处理"
                      : "开始处理",
                enabled: startable && startStatus !== "pending" && startStatus !== "success"
              };

  return {
    productId,
    revisionId: String(item.currentRevisionId),
    thumbnailUrl: ui.thumbnailUrl ?? null,
    title: item.targetTitle ?? item.canonicalSourceTitle ?? productId,
    sourceLabel: item.sourceItemId
      ? `${item.miaoshouSource === "local_captured" ? "1688 本地采集" : "1688"} · ${String(item.sourceItemId)}`
      : "1688",
    sourceUrl: ui.sourceUrl ?? null,
    collectedAtLabel: formatDate(ui.collectedAt),
    businessStage: effectiveStage,
    businessStatusLabel: STAGE_LABELS[effectiveStage],
    imageProgressLabel: optimisticProcessing
      ? `等待 Canvas · 主图 ${Math.min(item.usableCanvasOutputCount, 5)}/5`
      : buildImageProgress(item),
    issueLabel: issue,
    nextAction,
    canBatchStart: effectiveStage === "pending" && startable && startStatus !== "pending" && startStatus !== "success",
    canBatchConfirm: effectiveStage === "review" && item.usableCanvasOutputCount > 0,
    canBatchRetry: effectiveStage === "needs_attention"
  };
}
