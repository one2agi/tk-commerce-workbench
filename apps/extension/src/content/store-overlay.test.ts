import { afterEach, describe, expect, it, vi } from "vitest";
import { createScanStore } from "./scan-store.js";
import {
  OVERLAY_PREVIEW_LIMIT,
  createStoreOverlay,
  createSubmitSelectedMessage,
  sendSubmission,
  visiblePreviewCards
} from "./store-overlay.js";

describe("store overlay message", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "chrome");
    document.body.innerHTML = "";
  });
  it("includes a non-empty batch id with only the selected items", () => {
    const selected = [{
      sourceItemId: "892408514788",
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      title: "工装短裤"
    }];

    expect(createSubmitSelectedMessage("batch_abc", selected)).toEqual({
      kind: "submit-selected",
      batchId: "batch_abc",
      items: selected
    });
  });

  it("surfaces a paused response and can retry the same idempotent batch", async () => {
    const responses = [{ outcome: "paused", reason: "api_unavailable" }, { outcome: "submitted", accepted: 1 }];
    const runtime = { sendMessage: (_message: unknown, callback: (response: unknown) => void) => callback(responses.shift()) };
    const message = createSubmitSelectedMessage("batch_abc", []);
    await expect(sendSubmission(runtime, message)).resolves.toMatchObject({ outcome: "paused" });
    await expect(sendSubmission(runtime, message)).resolves.toMatchObject({ outcome: "submitted" });
  });

  it("times out when the extension background does not answer", async () => {
    const runtime = { sendMessage: vi.fn() };
    const message = createSubmitSelectedMessage("batch_abc", []);

    await expect(sendSubmission(runtime, message, { timeoutMs: 5 }))
      .resolves.toMatchObject({ outcome: "paused", reason: "background_timeout" });
  });

  it("surfaces an invalidated extension context as a reloadable state", async () => {
    const runtime = {
      sendMessage: vi.fn(() => {
        throw new Error("Extension context invalidated.");
      })
    };
    const message = createSubmitSelectedMessage("batch_abc", []);

    await expect(sendSubmission(runtime, message, { timeoutMs: 5 }))
      .resolves.toMatchObject({ outcome: "paused", reason: "extension_context_invalidated" });
  });

  it("caps the preview list so large 1688 pages keep the overlay lightweight", () => {
    const cards = Array.from({ length: OVERLAY_PREVIEW_LIMIT + 20 }, (_, index) => ({
      sourceItemId: String(100000000000 + index),
      sourceUrl: `https://detail.1688.com/offer/${100000000000 + index}.html`,
      title: `商品 ${index}`
    }));

    expect(visiblePreviewCards(cards)).toHaveLength(OVERLAY_PREVIEW_LIMIT);
  });

  it("ignores paused batches created by the old link-only extension", () => {
    const runtime = {
      sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
        if ((message as { kind?: string }).kind === "get-paused-submission") {
          callback({
            batchId: "legacy_batch",
            items: [{
              sourceItemId: "892408514788",
              sourceUrl: "https://detail.1688.com/offer/892408514788.html"
            }]
          });
        }
      })
    };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime }
    });
    const store = createScanStore(document.body);
    const overlay = createStoreOverlay();

    overlay.mount(store, document.body);

    expect(document.querySelector("[data-tk-overlay='store-listing']")?.textContent)
      .not.toContain("检测到上次已采集");
    overlay.unmount();
  });

  it("keeps the floating panel focused on count and submit instead of rendering checkbox rows", () => {
    document.body.innerHTML = `
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/111111111111.html">
        <img src="https://img.example.test/111.jpg" alt="商品图 111">
        <span class="title-text">商品 111</span>
      </a>
    `;
    const store = createScanStore(document.body);
    const overlay = createStoreOverlay();
    overlay.mount(store, document.body);
    try {
      store.rescan();
      store.select("111111111111", true);
      const panel = document.querySelector<HTMLElement>("[data-tk-overlay='store-listing']");

      expect(panel?.textContent).toContain("已扫描 1 个商品，已选 1");
      expect(panel?.textContent).toContain("提交已选 (1)");
      expect(panel?.querySelectorAll("input[type='checkbox']")).toHaveLength(0);
      expect(panel?.textContent).not.toContain("111111111111 商品 111");
    } finally {
      overlay.unmount();
    }
  });

  it("shows the loaded collector version and validation failure reason", async () => {
    document.body.innerHTML = `
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/111111111111.html">
        <img src="https://img.example.test/111.jpg">
        <span class="title-text">商品 111</span>
      </a>
    `;
    const runtime = {
      sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
        if ((message as { kind?: string }).kind === "get-paused-submission") callback(null);
        else callback({ outcome: "paused", reason: "http_400", items: [] });
      }),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime }
    });
    const store = createScanStore(document.body);
    const overlay = createStoreOverlay();
    overlay.mount(store, document.body);
    store.rescan();
    store.selectAll();

    Array.from(document.querySelectorAll<HTMLButtonElement>(
      "[data-tk-overlay='store-listing'] button"
    )).find((button) => button.textContent?.startsWith("提交已选"))?.click();
    await Promise.resolve();

    const panel = document.querySelector("[data-tk-overlay='store-listing']");
    expect(panel?.textContent).toContain("采集器 v3");
    expect(panel?.textContent).toContain("采集数据未通过校验");
    overlay.unmount();
  });

  it("shows a clear failure when the background script does not answer", async () => {
    document.body.innerHTML = `
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/111111111111.html">
        <img src="https://img.example.test/111.jpg">
        <span class="title-text">商品 111</span>
      </a>
    `;
    const runtime = {
      sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
        if ((message as { kind?: string }).kind === "get-paused-submission") callback(null);
      }),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime }
    });
    const store = createScanStore(document.body);
    const overlay = createStoreOverlay({ submissionTimeoutMs: 5 });
    overlay.mount(store, document.body);
    store.rescan();
    store.selectAll();

    Array.from(document.querySelectorAll<HTMLButtonElement>(
      "[data-tk-overlay='store-listing'] button"
    )).find((button) => button.textContent?.startsWith("提交已选"))?.click();
    await new Promise((resolve) => setTimeout(resolve, 10));

    const panel = document.querySelector("[data-tk-overlay='store-listing']");
    expect(panel?.textContent).toContain("扩展后台无响应");
    overlay.unmount();
  });

  it("shows live detail capture progress and exposes failed items for retry", async () => {
    document.body.innerHTML = `
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/111111111111.html">
        <img src="https://img.example.test/111.jpg">
        <span class="title-text">商品 111</span>
      </a>
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/222222222222.html">
        <img src="https://img.example.test/222.jpg">
        <span class="title-text">商品 222</span>
      </a>
    `;
    let progressListener: ((message: unknown) => void) | undefined;
    let submitCallback: ((response: unknown) => void) | undefined;
    let submittedMessage: { batchId?: string } | undefined;
    const runtime = {
      sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
        if ((message as { kind?: string }).kind === "get-paused-submission") callback(null);
        else {
          submittedMessage = message as { batchId?: string };
          submitCallback = callback;
        }
      }),
      onMessage: {
        addListener: vi.fn((listener: (message: unknown) => void) => {
          progressListener = listener;
        }),
        removeListener: vi.fn()
      }
    };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime }
    });
    const store = createScanStore(document.body);
    const overlay = createStoreOverlay();
    overlay.mount(store, document.body);
    store.rescan();
    store.selectAll();

    Array.from(document.querySelectorAll<HTMLButtonElement>(
      "[data-tk-overlay='store-listing'] button"
    )).find((button) => button.textContent?.startsWith("提交已选"))?.click();
    progressListener?.({
      kind: "capture-progress",
      batchId: submittedMessage?.batchId,
      state: "capturing",
      total: 2,
      current: 2,
      succeeded: 1,
      failed: 0
    });

    expect(document.querySelector("[data-tk-submit-status]")?.textContent)
      .toContain("正在采集详情 2/2");

    submitCallback?.({
      outcome: "submitted",
      accepted: 1,
      captureSummary: { total: 2, succeeded: 1, failed: 1 },
      failedItems: [{
        sourceItemId: "222222222222",
        sourceUrl: "https://detail.1688.com/offer/222222222222.html",
        title: "商品 222"
      }]
    });
    await Promise.resolve();

    const panel = document.querySelector("[data-tk-overlay='store-listing']");
    expect(panel?.textContent).toContain("成功 1，失败 1，已入库 1");
    expect(panel?.textContent).toContain("重试失败项 (1)");
    overlay.unmount();
  });

  it("shows the concrete detail capture failure reason", async () => {
    document.body.innerHTML = `
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/111111111111.html">
        <img src="https://img.example.test/111.jpg">
        <span class="title-text">商品 111</span>
      </a>
    `;
    const runtime = {
      sendMessage: vi.fn((message: unknown, callback: (response: unknown) => void) => {
        if ((message as { kind?: string }).kind === "get-paused-submission") callback(null);
        else callback({
          outcome: "paused",
          reason: "capture_failed",
          failedItems: [{
            sourceItemId: "111111111111",
            sourceUrl: "https://detail.1688.com/offer/111111111111.html",
            title: "商品 111"
          }],
          failureReasons: [{
            sourceItemId: "111111111111",
            reason: "detail_capture_no_response"
          }]
        });
      }),
      onMessage: {
        addListener: vi.fn(),
        removeListener: vi.fn()
      }
    };
    Object.defineProperty(globalThis, "chrome", {
      configurable: true,
      value: { runtime }
    });
    const store = createScanStore(document.body);
    const overlay = createStoreOverlay();
    overlay.mount(store, document.body);
    store.rescan();
    store.selectAll();

    Array.from(document.querySelectorAll<HTMLButtonElement>(
      "[data-tk-overlay='store-listing'] button"
    )).find((button) => button.textContent?.startsWith("提交已选"))?.click();
    await Promise.resolve();

    expect(document.querySelector("[data-tk-overlay='store-listing']")?.textContent)
      .toContain("详情页脚本未响应");
    overlay.unmount();
  });
});
