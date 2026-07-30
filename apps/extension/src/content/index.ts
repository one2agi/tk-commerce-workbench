import { createScanStore } from "./scan-store.js";
import { createDetailCaptureMessageHandler } from "./detail-parser.js";
import { installPageImageSelectionControls } from "./page-image-selection.js";
import { createStoreOverlay } from "./store-overlay.js";

export function bootstrapCollector(root: HTMLElement = document.body): () => void {
  const store = createScanStore(root);
  const overlay = createStoreOverlay();
  const cleanupPageSelection = installPageImageSelectionControls(store, root);
  overlay.mount(store, root);
  store.start();
  return () => {
    cleanupPageSelection();
    overlay.unmount();
    store.stop();
  };
}

type ContentRuntime = {
  sendMessage?(message: unknown): Promise<unknown> | void;
  onMessage: {
    addListener(listener: (
      message: unknown,
      sender: unknown,
      sendResponse: (response: unknown) => void
    ) => boolean): void;
  };
};

type DetailCaptureGlobal = typeof globalThis & {
  __tkDetailCaptureHandlerRegistered?: boolean;
};

export function registerDetailCaptureHandler(
  runtime: ContentRuntime,
  currentDocument: Document = document
): void {
  const globalState = globalThis as DetailCaptureGlobal;
  if (globalState.__tkDetailCaptureHandlerRegistered) return;
  globalState.__tkDetailCaptureHandlerRegistered = true;
  const handler = createDetailCaptureMessageHandler(
    currentDocument,
    currentDocument.location?.href ?? "",
    {
      onStage: (stage) => {
        sendRuntimeMessageSilently(runtime, { kind: "capture-stage", stage });
      }
    }
  );
  runtime.onMessage.addListener((message, _sender, sendResponse) =>
    handler(message, sendResponse)
  );
}

export function sendRuntimeMessageSilently(
  runtime: Pick<ContentRuntime, "sendMessage">,
  message: unknown
): void {
  try {
    const result = runtime.sendMessage?.(message);
    if (isPromiseLike(result)) void result.catch(() => undefined);
  } catch {
    // Extension contexts can be invalidated while a hidden detail tab is closing.
    // Progress messages are best-effort; they must never break the capture itself.
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof value === "object" && "catch" in value
    && typeof (value as { catch?: unknown }).catch === "function");
}

const chromeRuntime = (globalThis as { chrome?: { runtime?: ContentRuntime } }).chrome?.runtime;
if (chromeRuntime) registerDetailCaptureHandler(chromeRuntime);
// The legacy list-page selector remains available through bootstrapCollector,
// but v3 intentionally exposes only the current-detail popup workflow.
