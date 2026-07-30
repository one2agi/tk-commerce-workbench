type CaptureSummaryInput = {
  title: string;
  sourcePriceWire?: { amountMinor: string; currency: "CNY" } | null;
  sourcePriceRangeWire?: {
    minAmountMinor: string;
    maxAmountMinor: string;
    currency: "CNY";
  } | null;
  sourceStock: number | null;
  skus: ReadonlyArray<unknown>;
  mainImages: ReadonlyArray<string>;
  detailImages: ReadonlyArray<string>;
  captureQuality: "detail_page_complete" | "detail_page_partial";
  diagnostics: { warnings: ReadonlyArray<string> };
};

export type PopupCaptureSummary = Readonly<{
  title: string;
  price: string;
  stock: string;
  skuCount: number;
  mainImageCount: number;
  detailImageCount: number;
  quality: "完整" | "部分成功";
  warnings: string[];
}>;

export type PopupCaptureResult =
  | Readonly<{
      kind: "success";
      productId: string;
      revisionId: string;
      summary: PopupCaptureSummary;
    }>
  | Readonly<{
      kind: "error";
      reason: string;
      message: string;
    }>;

const WARNING_LABELS: Record<string, string> = {
  detail_capture_incomplete: "详情采集不完整",
  missing_attributes: "商品属性采集不完整",
  missing_source_price: "价格采集不完整",
  missing_source_stock: "库存采集不完整",
  missing_sku: "SKU采集不完整",
  missing_weight: "重量采集不完整",
  missing_dimensions: "包装尺寸采集不完整"
};

const ERROR_LABELS: Record<string, string> = {
  missing_token: "尚未连接工作台，请先完成连接设置",
  api_unavailable: "本地工作台服务不可用，请确认服务已启动",
  extension_upgrade_required: "扩展版本过旧，请重新加载最新构建",
  detail_title_missing: "未识别到商品标题，请确认当前是正常商品详情页",
  detail_title_is_supplier: "页面标题被识别为供应商名称，采集已停止",
  detail_main_images_missing: "未识别到有效商品主图",
  detail_source_item_mismatch: "页面商品编号与当前链接不一致",
  detail_capture_failed: "商品详情采集失败，请重试"
};

export function is1688DetailUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "detail.1688.com"
      && /^\/offer\/\d+\.html$/iu.test(url.pathname);
  } catch {
    return false;
  }
}

export async function captureCurrentDetail(input: {
  tabId: number;
  url: string;
  batchId?: string;
  now?: () => number;
  sendMessage(message: unknown): Promise<unknown>;
}): Promise<PopupCaptureResult> {
  const sourceItemId = sourceItemIdFromUrl(input.url);
  if (!Number.isInteger(input.tabId) || input.tabId < 0 || !sourceItemId) {
    return {
      kind: "error",
      reason: "not_1688_detail_page",
      message: "请先打开一个1688商品详情页"
    };
  }
  const response = await input.sendMessage({
    kind: "capture-current-detail",
    tabId: input.tabId,
    batchId: input.batchId ?? `detail-${sourceItemId}-${(input.now ?? Date.now)()}`
  }).catch(() => null);
  if (!response || typeof response !== "object") {
    return {
      kind: "error",
      reason: "background_unavailable",
      message: "扩展后台无响应，请重新加载扩展后重试"
    };
  }
  const value = response as Record<string, unknown>;
  if (value.outcome !== "submitted") {
    const reason = typeof value.reason === "string" ? value.reason : "detail_capture_failed";
    return { kind: "error", reason, message: errorMessage(reason) };
  }
  const capture = value.capture;
  const products = Array.isArray(value.products) ? value.products : [];
  const product = products[0];
  if (!isCaptureSummaryInput(capture)
    || !product
    || typeof product !== "object"
    || typeof (product as Record<string, unknown>).productId !== "string"
    || typeof (product as Record<string, unknown>).revisionId !== "string") {
    return {
      kind: "error",
      reason: "invalid_capture_response",
      message: "工作台返回结果不完整，请查看服务日志"
    };
  }
  return {
    kind: "success",
    productId: String((product as Record<string, unknown>).productId),
    revisionId: String((product as Record<string, unknown>).revisionId),
    summary: formatCaptureSummary(capture)
  };
}

export function formatCaptureSummary(capture: CaptureSummaryInput): PopupCaptureSummary {
  const range = capture.sourcePriceRangeWire;
  const price = range
    ? range.minAmountMinor === range.maxAmountMinor
      ? formatCny(range.minAmountMinor)
      : `${formatCny(range.minAmountMinor)}–${minorUnits(range.maxAmountMinor)}`
    : capture.sourcePriceWire
      ? formatCny(capture.sourcePriceWire.amountMinor)
      : "源页面未提供";
  return {
    title: capture.title,
    price,
    stock: capture.sourceStock === null ? "源页面未提供" : String(capture.sourceStock),
    skuCount: capture.skus.length,
    mainImageCount: capture.mainImages.length,
    detailImageCount: capture.detailImages.length,
    quality: capture.captureQuality === "detail_page_complete" ? "完整" : "部分成功",
    warnings: capture.diagnostics.warnings.map((code) => WARNING_LABELS[code] ?? code)
  };
}

export function errorMessage(reason: string): string {
  if (/^http_\d+$/u.test(reason)) return `工作台提交失败（${reason.slice(5)}）`;
  return ERROR_LABELS[reason] ?? `采集失败：${reason}`;
}

function sourceItemIdFromUrl(rawUrl: string): string | null {
  if (!is1688DetailUrl(rawUrl)) return null;
  return /\/offer\/(\d+)\.html/iu.exec(new URL(rawUrl).pathname)?.[1] ?? null;
}

function formatCny(amountMinor: string): string {
  return `¥${minorUnits(amountMinor)}`;
}

function minorUnits(amountMinor: string): string {
  const value = BigInt(amountMinor);
  return `${value / 100n}.${(value % 100n).toString().padStart(2, "0")}`;
}

function isCaptureSummaryInput(value: unknown): value is CaptureSummaryInput {
  if (!value || typeof value !== "object") return false;
  const capture = value as Partial<CaptureSummaryInput>;
  return typeof capture.title === "string"
    && (capture.sourceStock === null || Number.isInteger(capture.sourceStock))
    && Array.isArray(capture.skus)
    && Array.isArray(capture.mainImages)
    && Array.isArray(capture.detailImages)
    && (capture.captureQuality === "detail_page_complete"
      || capture.captureQuality === "detail_page_partial")
    && Boolean(capture.diagnostics)
    && Array.isArray(capture.diagnostics?.warnings);
}
