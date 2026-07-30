import type { LocalDetailCapture } from "../content/detail-parser.js";
import type { CaptureTabPort } from "./capture-queue.js";

type ChromeTab = { id?: number; status?: string };

export interface ChromeTabsApi {
  create(properties: { url: string; active: boolean }): Promise<ChromeTab>;
  get?(tabId: number): Promise<ChromeTab>;
  remove(tabId: number): Promise<void>;
  sendMessage(
    tabId: number,
    message: unknown,
    callback?: (response: unknown) => void
  ): Promise<unknown> | void;
  onUpdated: {
    addListener(listener: (tabId: number, changeInfo: { status?: string }) => void): void;
    removeListener(listener: (tabId: number, changeInfo: { status?: string }) => void): void;
  };
}

export function createChromeCaptureTabPort(
  tabs: ChromeTabsApi,
  options: {
    timeoutMs?: number;
    captureResponseGraceMs?: number;
    maxCaptureAttempts?: number;
    retryDelayMs?: number;
    delay?: (milliseconds: number) => Promise<void>;
    injectContentScript?: (tabId: number) => Promise<void>;
  } = {}
): CaptureTabPort {
  const timeoutMs = options.timeoutMs ?? 45_000;
  const captureResponseGraceMs = options.captureResponseGraceMs ?? 5_000;
  // Retry only when the content script is not ready yet. Once it answers with
  // a real parser/validation result, the content script has already done the
  // SPA stability wait and we should not repeat that long wait.
  const maxCaptureAttempts = options.maxCaptureAttempts ?? 3;
  const retryDelayMs = options.retryDelayMs ?? 750;
  const delay = options.delay ?? ((milliseconds: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, milliseconds)));
  const injectContentScript = options.injectContentScript;
  return {
    async open(url) {
      const tab = await tabs.create({ url, active: false });
      if (typeof tab.id !== "number") throw new Error("detail_tab_open_failed");
      return tab.id;
    },
    async waitUntilComplete(tabId) {
      const existing = await tabs.get?.(tabId).catch(() => undefined);
      if (existing?.status === "complete") return;
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          tabs.onUpdated.removeListener(listener);
          reject(new Error("detail_page_timeout"));
        }, timeoutMs);
        const listener = (updatedTabId: number, changeInfo: { status?: string }) => {
          if (updatedTabId !== tabId || changeInfo.status !== "complete") return;
          clearTimeout(timeout);
          tabs.onUpdated.removeListener(listener);
          resolve();
        };
        tabs.onUpdated.addListener(listener);
      });
    },
    async capture(tabId) {
      let lastError = "detail_capture_no_response";
      for (let attempt = 1; attempt <= maxCaptureAttempts; attempt += 1) {
        try {
          const response = await withTimeout(
            sendMessageToTab(tabs, tabId, { kind: "capture-detail" }),
            timeoutMs + captureResponseGraceMs,
            "detail_capture_timeout"
          );
          if (response && typeof response === "object") {
            const result = response as { ok?: unknown; capture?: unknown; error?: unknown };
            if (result.ok === true && result.capture && typeof result.capture === "object") {
              return result.capture as LocalDetailCapture;
            }
            lastError = typeof result.error === "string"
              ? result.error
              : "detail_capture_failed";
          }
        } catch (error) {
          lastError = error instanceof Error && /^detail_[a-z_]+$/.test(error.message)
            ? error.message
            : "detail_capture_no_response";
        }
        if (lastError !== "detail_capture_no_response") break;
        if (attempt < maxCaptureAttempts) {
          await injectContentScript?.(tabId).catch(() => undefined);
          await delay(retryDelayMs);
        }
      }
      throw new Error(lastError);
    },
    async close(tabId) {
      await tabs.remove(tabId);
    }
  };
}

function sendMessageToTab(tabs: ChromeTabsApi, tabId: number, message: unknown): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (value: unknown) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      const maybePromise = tabs.sendMessage(tabId, message, settle);
      if (isPromiseLike(maybePromise)) {
        maybePromise.then(settle, fail);
      }
    } catch (error) {
      fail(error);
    }
  });
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof value === "object" && "then" in value
    && typeof (value as { then?: unknown }).then === "function");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, reason: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(reason)), timeoutMs);
    promise
      .then((value) => {
        clearTimeout(timeout);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timeout);
        reject(error);
      });
  });
}
