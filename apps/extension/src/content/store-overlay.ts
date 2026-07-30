// Lightweight control panel for the 1688 listing page. Product selection stays
// on the product images; this panel owns detail-capture progress and submission.

import type { IngestLocalCaptureItemV3 } from "@tk/contracts/commands";

import type { ScanStore, ScannedCard } from "./scan-store.js";

export const OVERLAY_PREVIEW_LIMIT = 40;
export const COLLECTOR_VERSION_LABEL = "采集器 v3 · 当前详情页";

export interface OverlayHandle {
  mount(store: ScanStore, host: HTMLElement): void;
  unmount(): void;
}

export interface StoreOverlayOptions {
  readonly submissionTimeoutMs?: number;
}

export function visiblePreviewCards(cards: ReadonlyArray<ScannedCard>): ReadonlyArray<ScannedCard> {
  return cards.slice(0, OVERLAY_PREVIEW_LIMIT);
}

type SelectedSubmissionMessage = ReturnType<typeof createSubmitSelectedMessage>;
type CapturedSubmissionMessage = Readonly<{
  kind: "retry-captured-submission";
  batchId: string;
  items: ReadonlyArray<Omit<IngestLocalCaptureItemV3, "idempotencyKey">>;
}>;
type SubmissionMessage = SelectedSubmissionMessage | CapturedSubmissionMessage;

type CaptureProgressMessage = Readonly<{
  kind: "capture-progress";
  batchId: string;
  state: "capturing" | "item_succeeded" | "item_failed" | "completed";
  total: number;
  current: number;
  succeeded: number;
  failed: number;
  reason?: string;
}>;

type CaptureStageMessage = Readonly<{
  kind: "capture-stage";
  stage: "waiting_product" | "loading_detail" | "validating";
}>;

type SubmissionResponse = {
  outcome?: "submitted" | "paused";
  accepted?: number;
  reason?: string;
  items?: CapturedSubmissionMessage["items"];
  failedItems?: ScannedCard[];
  failureReasons?: Array<{ sourceItemId: string; reason: string }>;
  captureSummary?: { total: number; succeeded: number; failed: number };
} | null;

export type ExtensionRuntime = {
  sendMessage(message: unknown, callback: (response: unknown) => void): void;
  onMessage?: {
    addListener(listener: (message: unknown) => boolean | void): void;
    removeListener(listener: (message: unknown) => boolean | void): void;
  };
};

export function createStoreOverlay(options: StoreOverlayOptions = {}): OverlayHandle {
  let store: ScanStore | null = null;
  let panel: HTMLDivElement | null = null;
  let unsub: (() => void) | null = null;
  let runtime: ExtensionRuntime | null = null;
  let batchId = createBatchId();
  let feedback = "";
  let retryMessage: SubmissionMessage | null = null;
  let retryLabel = "";

  const progressListener = (message: unknown): boolean => {
    if (isCaptureStageMessage(message)) {
      feedback = message.stage === "loading_detail"
        ? "正在加载商品详情图片与正文"
        : message.stage === "validating"
          ? "详情已稳定，正在校验商品数据"
          : "正在等待 1688 商品数据加载";
      render();
      return false;
    }
    if (!isCaptureProgressMessage(message) || message.batchId !== batchId) return false;
    if (message.state === "capturing") {
      feedback = `正在采集详情 ${message.current}/${message.total} · 成功 ${message.succeeded} · 失败 ${message.failed}`;
    } else if (message.state === "item_failed") {
      feedback = `详情采集失败 ${message.failed} 个，继续处理剩余商品`;
    } else if (message.state === "completed") {
      feedback = `详情采集完成 · 成功 ${message.succeeded} · 失败 ${message.failed} · 正在入库`;
    }
    render();
    return false;
  };

  function render(): void {
    if (!store || !panel) return;
    const cards = store.snapshot();
    const selected = store.selection();
    panel.innerHTML = "";

    const version = document.createElement("div");
    version.dataset.tkCollectorVersion = "true";
    version.textContent = COLLECTOR_VERSION_LABEL;
    version.style.fontWeight = "600";
    version.style.marginBottom = "4px";
    panel.appendChild(version);

    const title = document.createElement("div");
    title.textContent = `已扫描 ${cards.length} 个商品，已选 ${selected.size}`;
    panel.appendChild(title);
    if (feedback) {
      const status = document.createElement("div");
      status.dataset.tkSubmitStatus = "true";
      status.setAttribute("role", "status");
      status.setAttribute("aria-live", "polite");
      status.textContent = feedback;
      panel.appendChild(status);
    }

    const controls = document.createElement("div");
    controls.style.display = "flex";
    controls.style.flexWrap = "wrap";
    controls.style.gap = "6px";
    controls.style.margin = "6px 0";
    const scanButton = document.createElement("button");
    scanButton.type = "button";
    scanButton.textContent = "扫描当前页";
    scanButton.addEventListener("click", () => {
      const found = store!.rescan().length;
      feedback = `已扫描当前页：${found} 个商品`;
      render();
    });
    controls.appendChild(scanButton);
    const clearButton = document.createElement("button");
    clearButton.type = "button";
    clearButton.textContent = "清空选择";
    clearButton.disabled = selected.size === 0;
    clearButton.addEventListener("click", () => store!.clearSelection());
    controls.appendChild(clearButton);
    panel.appendChild(controls);

    const hint = document.createElement("div");
    hint.textContent = cards.length === 0
      ? "点击扫描当前页后，在商品图片右上角勾选。"
      : "勾选后提交；扩展会逐个采集详情，采齐后才进入工作台。";
    hint.style.margin = "4px 0 8px";
    hint.style.color = "#555";
    panel.appendChild(hint);

    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.textContent = `提交已选 (${selected.size})`;
    submitButton.disabled = selected.size === 0;
    submitButton.addEventListener("click", () => {
      void submitMessage(createSubmitSelectedMessage(batchId, store!.selectedBatch()));
    });
    panel.appendChild(submitButton);

    if (retryMessage) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = retryLabel || `重试待提交批次 (${retryMessage.items.length})`;
      retry.addEventListener("click", () => void submitMessage(retryMessage!));
      panel.appendChild(retry);
    }
  }

  async function submitMessage(message: SubmissionMessage): Promise<void> {
    if (!runtime) {
      feedback = "扩展后台不可用，待恢复后重试";
      retryMessage = message;
      retryLabel = `重试待提交批次 (${message.items.length})`;
      render();
      return;
    }
    feedback = message.kind === "submit-selected" ? "准备逐个采集详情…" : "正在重新提交已采集数据…";
    render();
    const response = await sendSubmission(runtime, message, {
      timeoutMs: options.submissionTimeoutMs
    });
    const summary = response?.captureSummary;
    if (response?.outcome === "submitted") {
      const accepted = response.accepted ?? summary?.succeeded ?? message.items.length;
      feedback = summary
        ? `详情采集完成：成功 ${summary.succeeded}，失败 ${summary.failed}，已入库 ${accepted}`
        : `已入库 ${accepted} 个商品`;
      if ((response.failedItems?.length ?? 0) > 0) {
        retryMessage = createSubmitSelectedMessage(batchId, response.failedItems!);
        retryLabel = `重试失败项 (${response.failedItems!.length})`;
      } else {
        retryMessage = null;
        retryLabel = "";
        batchId = createBatchId();
        store?.clearSelection();
      }
    } else if (response?.reason === "capture_failed") {
      const failedItems = response.failedItems ?? [];
      const reasonText = describeCaptureFailure(response.failureReasons?.[0]?.reason);
      feedback = `详情采集失败 ${failedItems.length || message.items.length} 个，未创建空商品${reasonText ? `：${reasonText}` : ""}`;
      retryMessage = failedItems.length > 0
        ? createSubmitSelectedMessage(batchId, failedItems)
        : message;
      retryLabel = `重试失败项 (${retryMessage.items.length})`;
    } else {
      feedback = humanSubmissionFailure(response?.reason);
      retryMessage = response?.items && response.items.length > 0
        ? createRetryCapturedMessage(batchId, response.items)
        : message;
      retryLabel = `重试待提交批次 (${retryMessage.items.length})`;
    }
    render();
  }

  return {
    mount(nextStore, host) {
      batchId = createBatchId();
      store = nextStore;
      panel = document.createElement("div");
      panel.dataset.tkOverlay = "store-listing";
      panel.style.position = "fixed";
      panel.style.right = "12px";
      panel.style.bottom = "12px";
      panel.style.zIndex = "2147483646";
      panel.style.boxSizing = "border-box";
      panel.style.width = "min(360px, calc(100vw - 24px))";
      panel.style.maxHeight = "50vh";
      panel.style.overflow = "auto";
      panel.style.background = "white";
      panel.style.border = "1px solid #ccc";
      panel.style.padding = "8px";
      panel.style.fontSize = "12px";
      host.appendChild(panel);
      unsub = store.subscribe(() => render());
      runtime = getRuntime();
      runtime?.onMessage?.addListener(progressListener);
      render();
      runtime?.sendMessage({ kind: "get-paused-submission" }, (saved) => {
        if (!isSavedCapturedBatch(saved)) return;
        retryMessage = createRetryCapturedMessage(saved.batchId, saved.items);
        retryLabel = `重试待提交批次 (${saved.items.length})`;
        feedback = "检测到上次已采集但尚未入库的批次";
        render();
      });
    },
    unmount() {
      unsub?.();
      unsub = null;
      runtime?.onMessage?.removeListener(progressListener);
      runtime = null;
      panel?.remove();
      panel = null;
      store = null;
    }
  };
}

function describeCaptureFailure(reason: string | undefined): string {
  if (reason === "detail_capture_no_response") return "详情页脚本未响应，请刷新 1688 页面或重载扩展后重试";
  if (reason === "detail_capture_timeout") return "详情页采集超时，1688 商品数据未稳定加载";
  if (reason === "detail_page_timeout") return "详情页打开超时";
  if (reason === "detail_title_missing") return "未读取到商品标题";
  if (reason === "detail_title_is_supplier") return "标题疑似供应商名称";
  if (reason === "detail_main_images_missing") return "未读取到合格商品主图";
  if (reason === "detail_section_incomplete") return "详情图片区未加载完整";
  if (reason === "detail_attributes_incomplete") return "属性区域存在但未加载完整";
  if (reason === "detail_sku_incomplete") return "SKU 区域存在但未加载完整";
  if (reason === "detail_source_item_mismatch") return "详情页商品 ID 与所选商品不一致";
  if (reason === "detail_source_item_id_missing") return "详情页 URL 缺少商品 ID";
  if (reason === "detail_tab_open_failed") return "无法打开后台详情页";
  if (reason === "detail_capture_failed") return "详情页采集脚本执行失败";
  return reason ?? "";
}

function humanSubmissionFailure(reason: string | undefined): string {
  if (reason === "missing_token") return "请先在扩展设置中填写访问令牌";
  if (reason === "extension_upgrade_required") return "扩展版本过旧，请在 Edge 扩展页点击重新加载后再提交";
  if (reason === "capture_failed") return "详情采集失败，未创建空商品";
  if (reason === "api_unavailable") return "无法连接本地平台 3000，已保留采集结果；请确认 http://127.0.0.1:3000 可打开后点重试";
  if (reason === "background_timeout") return "扩展后台无响应，请在 Edge 扩展页重新加载后刷新 1688 页面";
  if (reason === "extension_context_invalidated") return "扩展上下文已失效，请刷新当前 1688 页面后重新勾选提交";
  if (reason === "http_400") return "采集数据未通过校验，请刷新 1688 页面后重试";
  if (reason === "http_401") return "访问令牌不正确，请重新填写扩展令牌";
  if (reason?.startsWith("http_")) return `本地平台拒绝入库（${reason}），已保留采集结果`;
  return "本地平台暂不可用，已保留采集结果";
}

export function sendSubmission(
  runtime: ExtensionRuntime,
  message: SubmissionMessage,
  options: { timeoutMs?: number } = {}
): Promise<SubmissionResponse> {
  const timeoutMs = options.timeoutMs ?? 75_000;
  return new Promise((resolve) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ outcome: "paused", reason: "background_timeout", items: [] });
    }, timeoutMs);
    try {
      runtime.sendMessage(message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        resolve((response ?? null) as SubmissionResponse);
      });
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ outcome: "paused", reason: "extension_context_invalidated", items: [] });
    }
  });
}

function getRuntime(): ExtensionRuntime | null {
  return (globalThis as { chrome?: { runtime?: ExtensionRuntime } }).chrome?.runtime ?? null;
}

function isSavedCapturedBatch(value: unknown): value is {
  batchId: string;
  items: CapturedSubmissionMessage["items"];
} {
  if (!value || typeof value !== "object") return false;
  const saved = value as { batchId?: unknown; items?: unknown };
  if (typeof saved.batchId !== "string" || !Array.isArray(saved.items)) return false;
  return saved.items.every((item) => {
    if (!item || typeof item !== "object") return false;
    const capture = item as Partial<IngestLocalCaptureItemV3>;
    return typeof capture.title === "string"
      && Array.isArray(capture.mainImages)
      && Array.isArray(capture.detailImages)
      && (
        capture.captureQuality === "detail_page_complete"
        || capture.captureQuality === "detail_page_partial"
      )
      && capture.diagnostics?.pageKind === "offer_detail";
  });
}

function isCaptureProgressMessage(value: unknown): value is CaptureProgressMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<CaptureProgressMessage>;
  return message.kind === "capture-progress"
    && typeof message.batchId === "string"
    && typeof message.total === "number"
    && typeof message.current === "number";
}

function isCaptureStageMessage(value: unknown): value is CaptureStageMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<CaptureStageMessage>;
  return message.kind === "capture-stage"
    && ["waiting_product", "loading_detail", "validating"].includes(String(message.stage));
}

export function createSubmitSelectedMessage(
  batchId: string,
  items: ReadonlyArray<ScannedCard>
) {
  return Object.freeze({ kind: "submit-selected" as const, batchId, items });
}

function createRetryCapturedMessage(
  batchId: string,
  items: CapturedSubmissionMessage["items"]
): CapturedSubmissionMessage {
  return Object.freeze({ kind: "retry-captured-submission" as const, batchId, items });
}

function createBatchId(): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `batch_${random}`;
}
