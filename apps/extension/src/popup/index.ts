import { captureCurrentDetail, is1688DetailUrl } from "./popup-controller.js";

type ChromeTab = { id?: number; url?: string };
type ChromeRuntime = {
  openOptionsPage(): Promise<void> | void;
  sendMessage(message: unknown): Promise<unknown>;
};
type ChromeTabs = {
  query(queryInfo: { active: boolean; currentWindow: boolean }): Promise<ChromeTab[]>;
  create(createProperties: { url: string }): Promise<unknown> | void;
};

const chromeApi = (globalThis as {
  chrome?: { runtime?: ChromeRuntime; tabs?: ChromeTabs };
}).chrome;
const status = element<HTMLDivElement>("status");
const captureButton = element<HTMLButtonElement>("capture");
const settingsButton = element<HTMLButtonElement>("settings");
const summary = element<HTMLElement>("summary");
const openProductButton = element<HTMLButtonElement>("open-product");
let activeTab: Required<Pick<ChromeTab, "id" | "url">> | null = null;
let capturedProductId: string | null = null;
let pendingBatchId: string | null = null;

settingsButton.addEventListener("click", () => {
  void chromeApi?.runtime?.openOptionsPage();
});

captureButton.addEventListener("click", () => {
  if (!activeTab || !chromeApi?.runtime) return;
  captureButton.disabled = true;
  setStatus("正在读取商品价格、库存和SKU…");
  summary.style.display = "none";
  const sourceItemId = /\/offer\/(\d+)\.html/iu.exec(activeTab.url)?.[1] ?? "unknown";
  pendingBatchId ??= `detail-${sourceItemId}-${Date.now()}`;
  void captureCurrentDetail({
    tabId: activeTab.id,
    url: activeTab.url,
    batchId: pendingBatchId,
    sendMessage: (message) => chromeApi.runtime!.sendMessage(message)
  }).then((result) => {
    if (result.kind === "error") {
      setStatus(result.message, "error");
      captureButton.disabled = false;
      captureButton.textContent = "重新采集";
      return;
    }
    pendingBatchId = null;
    capturedProductId = result.productId;
    setStatus(
      result.summary.quality === "完整"
        ? "已完整写入工作台"
        : "已写入工作台，但存在需要检查的字段",
      result.summary.quality === "完整" ? "success" : "error"
    );
    renderSummary(result.summary);
    captureButton.disabled = false;
    captureButton.textContent = result.summary.quality === "完整" ? "再次采集" : "重新采集";
  });
});

openProductButton.addEventListener("click", () => {
  if (!capturedProductId) return;
  void chromeApi?.tabs?.create({
    url: `http://127.0.0.1:3000/products/${encodeURIComponent(capturedProductId)}`
  });
});

void initialize();

async function initialize(): Promise<void> {
  if (!chromeApi?.tabs || !chromeApi.runtime) {
    setStatus("扩展运行环境不可用，请重新加载扩展", "error");
    return;
  }
  const [tab] = await chromeApi.tabs.query({ active: true, currentWindow: true });
  if (!tab || typeof tab.id !== "number" || typeof tab.url !== "string" || !is1688DetailUrl(tab.url)) {
    setStatus("请先打开一个1688商品详情页", "error");
    return;
  }
  activeTab = { id: tab.id, url: tab.url };
  captureButton.disabled = false;
  setStatus(`已识别商品 ${/\/offer\/(\d+)\.html/iu.exec(tab.url)?.[1] ?? ""}`);
}

function renderSummary(value: {
  title: string;
  quality: string;
  price: string;
  stock: string;
  skuCount: number;
  mainImageCount: number;
  detailImageCount: number;
  warnings: string[];
}): void {
  element<HTMLElement>("summary-title").textContent = value.title;
  element<HTMLElement>("summary-quality").textContent = value.quality;
  element<HTMLElement>("summary-price").textContent = value.price;
  element<HTMLElement>("summary-stock").textContent = value.stock;
  element<HTMLElement>("summary-skus").textContent = String(value.skuCount);
  element<HTMLElement>("summary-main-images").textContent = String(value.mainImageCount);
  element<HTMLElement>("summary-detail-images").textContent = String(value.detailImageCount);
  const warnings = element<HTMLUListElement>("warnings");
  warnings.replaceChildren(...value.warnings.map((warning) => {
    const item = document.createElement("li");
    item.textContent = warning;
    return item;
  }));
  summary.style.display = "block";
  openProductButton.style.display = "block";
}

function setStatus(message: string, tone: "neutral" | "success" | "error" = "neutral"): void {
  status.textContent = message;
  status.dataset.tone = tone;
}

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`popup_element_missing:${id}`);
  return value as T;
}
