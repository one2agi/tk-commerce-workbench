import {
  createDetailCaptureQueue,
  type CaptureBatchResult,
  type CaptureProgress,
  type SelectedCaptureItem
} from "./capture-queue.js";
import {
  createChromeCaptureTabPort,
  type ChromeTabsApi
} from "./chrome-capture-tab-port.js";
import {
  createSubmitter,
  type SubmitBatchInput,
  type SubmitResult
} from "./submit-selected.js";

interface SubmitterLike {
  submitBatch(input: SubmitBatchInput): Promise<SubmitResult>;
  loadPausedBatch(): Promise<SubmitBatchInput | null>;
  hasToken?(): Promise<boolean>;
}

interface CaptureQueueLike {
  captureBatch(
    input: {
      batchId: string;
      items: ReadonlyArray<SelectedCaptureItem>;
    },
    report?: (progress: CaptureProgress) => void
  ): Promise<CaptureBatchResult>;
}

interface SubmitSelectedMessage {
  readonly kind: "submit-selected";
  readonly batchId: string;
  readonly items: ReadonlyArray<SelectedCaptureItem>;
}

interface RetryCapturedMessage extends SubmitBatchInput {
  readonly kind: "retry-captured-submission";
}

interface CaptureCurrentDetailMessage {
  readonly kind: "capture-current-detail";
  readonly tabId: number;
  readonly batchId: string;
}

export function createBackgroundMessageHandler(dependencies: {
  submitter: SubmitterLike;
  queue: CaptureQueueLike;
  captureCurrent?: (tabId: number) => Promise<SubmitBatchInput["items"][number]>;
  reportProgress?: (message: unknown) => void;
}) {
  return (message: unknown, sendResponse: (response: unknown) => void): boolean => {
    if (isCaptureStageMessage(message)) {
      dependencies.reportProgress?.(message);
      return false;
    }
    if (isGetPausedMessage(message)) {
      void dependencies.submitter.loadPausedBatch()
        .then(sendResponse)
        .catch(() => sendResponse(null));
      return true;
    }
    if (isRetryCapturedMessage(message)) {
      void dependencies.submitter.submitBatch({
        batchId: message.batchId,
        items: message.items
      }).then(sendResponse).catch(() =>
        sendResponse({ outcome: "paused", reason: "api_unavailable", items: message.items })
      );
      return true;
    }
    if (isCaptureCurrentDetailMessage(message)) {
      const run = async () => {
        if (dependencies.submitter.hasToken && !(await dependencies.submitter.hasToken())) {
          sendResponse({
            outcome: "paused",
            reason: "missing_token",
            items: []
          });
          return;
        }
        if (!dependencies.captureCurrent) {
          sendResponse({
            outcome: "paused",
            reason: "capture_current_unavailable",
            items: []
          });
          return;
        }
        try {
          const capture = await dependencies.captureCurrent(message.tabId);
          const submitted = await dependencies.submitter.submitBatch({
            batchId: message.batchId,
            items: [capture]
          });
          sendResponse({ ...submitted, capture });
        } catch (error) {
          sendResponse({
            outcome: "paused",
            reason: error instanceof Error ? error.message : "detail_capture_failed",
            items: []
          });
        }
      };
      void run();
      return true;
    }
    if (!isSubmitSelectedMessage(message)) return false;
    if (dependencies.submitter.hasToken) {
      void dependencies.submitter.hasToken()
        .then((hasToken) => {
          if (!hasToken) {
            sendResponse({
              outcome: "paused",
              reason: "missing_token",
              items: []
            });
            return;
          }
          captureAndSubmit(message, sendResponse, dependencies);
        })
        .catch(() => {
          sendResponse({
            outcome: "paused",
            reason: "missing_token",
            items: []
          });
        });
      return true;
    }
    captureAndSubmit(message, sendResponse, dependencies);
    return true;
  };
}

function captureAndSubmit(
  message: SubmitSelectedMessage,
  sendResponse: (response: unknown) => void,
  dependencies: {
    submitter: SubmitterLike;
    queue: CaptureQueueLike;
    reportProgress?: (message: unknown) => void;
  }
): void {
    void dependencies.queue
      .captureBatch(
        { batchId: message.batchId, items: message.items },
        (progress) => dependencies.reportProgress?.({
          kind: "capture-progress",
          batchId: message.batchId,
          ...progress
        })
      )
      .then(async (captured) => {
        const failedItems = captured.failures.map((failure) => failure.item);
        const failureReasons = captured.failures.map((failure) => ({
          sourceItemId: failure.item.sourceItemId,
          reason: failure.reason
        }));
        if (captured.captures.length === 0) {
          sendResponse({
            outcome: "paused",
            reason: "capture_failed",
            items: [],
            failedItems,
            failureReasons,
            captureSummary: {
              total: message.items.length,
              succeeded: 0,
              failed: captured.failures.length
            }
          });
          return;
        }
        const submitted = await dependencies.submitter.submitBatch({
          batchId: message.batchId,
          items: captured.captures
        });
        sendResponse({
          ...submitted,
          failedItems,
          failureReasons,
          captureSummary: {
            total: message.items.length,
            succeeded: captured.captures.length,
            failed: captured.failures.length
          }
        });
      })
      .catch(() =>
        sendResponse({
          outcome: "paused",
          reason: "capture_failed",
          items: [],
          failedItems: message.items,
          failureReasons: message.items.map((item) => ({
            sourceItemId: item.sourceItemId,
            reason: "detail_capture_failed"
          }))
        })
      );
}

export const createSubmitSelectedHandler = createBackgroundMessageHandler;

function isCaptureStageMessage(message: unknown): message is {
  kind: "capture-stage";
  stage: "waiting_product" | "loading_detail" | "validating";
} {
  if (!message || typeof message !== "object") return false;
  const value = message as { kind?: unknown; stage?: unknown };
  return value.kind === "capture-stage"
    && ["waiting_product", "loading_detail", "validating"].includes(String(value.stage));
}

function isGetPausedMessage(message: unknown): boolean {
  return Boolean(message && typeof message === "object"
    && (message as { kind?: string }).kind === "get-paused-submission");
}

function isSubmitSelectedMessage(message: unknown): message is SubmitSelectedMessage {
  if (!message || typeof message !== "object") return false;
  const value = message as Partial<SubmitSelectedMessage>;
  return value.kind === "submit-selected"
    && typeof value.batchId === "string"
    && value.batchId.length > 0
    && Array.isArray(value.items);
}

function isRetryCapturedMessage(message: unknown): message is RetryCapturedMessage {
  if (!message || typeof message !== "object") return false;
  const value = message as Partial<RetryCapturedMessage>;
  return value.kind === "retry-captured-submission"
    && typeof value.batchId === "string"
    && value.batchId.length > 0
    && Array.isArray(value.items);
}

function isCaptureCurrentDetailMessage(message: unknown): message is CaptureCurrentDetailMessage {
  if (!message || typeof message !== "object") return false;
  const value = message as Partial<CaptureCurrentDetailMessage>;
  return value.kind === "capture-current-detail"
    && Number.isInteger(value.tabId)
    && Number(value.tabId) >= 0
    && typeof value.batchId === "string"
    && value.batchId.length > 0;
}

type ChromeRuntime = {
  onMessage: {
    addListener(
      listener: (
        message: unknown,
        sender: unknown,
        sendResponse: (response: unknown) => void
      ) => boolean
    ): void;
  };
  sendMessage?(message: unknown): Promise<unknown> | void;
};

type ChromeStorage = Parameters<typeof createSubmitter>[0]["storage"];

type ChromeScripting = {
  executeScript(
    injection: {
      target: { tabId: number };
      files: string[];
      world?: "MAIN" | "ISOLATED";
    },
    callback?: () => void
  ): Promise<unknown> | void;
};

export function registerBackground(
  runtime: ChromeRuntime,
  storage: ChromeStorage,
  tabs: ChromeTabsApi,
  scripting?: ChromeScripting
): void {
  const submitter = createSubmitter({
    apiBase: "http://127.0.0.1:3000",
    storage
  });
  const capturePort = createChromeCaptureTabPort(tabs, {
    injectContentScript: scripting
      ? (tabId) => executeContentScript(scripting, tabId)
      : undefined
  });
  const queue = createDetailCaptureQueue(capturePort);
  const handler = createBackgroundMessageHandler({
    submitter,
    queue,
    captureCurrent: async (tabId) => {
      if (scripting) await executePageContextBridge(scripting, tabId);
      return capturePort.capture(tabId);
    },
    reportProgress: (message) => {
      sendRuntimeMessageSilently(runtime, message);
    }
  });
  runtime.onMessage.addListener((message, _sender, sendResponse) =>
    handler(message, sendResponse)
  );
}

export function executePageContextBridge(
  scripting: ChromeScripting,
  tabId: number
): Promise<void> {
  return executeScriptFile(scripting, {
    target: { tabId },
    files: ["page-context.js"],
    world: "MAIN"
  });
}

function executeContentScript(scripting: ChromeScripting, tabId: number): Promise<void> {
  return executeScriptFile(scripting, {
    target: { tabId },
    files: ["content.js"]
  });
}

function executeScriptFile(
  scripting: ChromeScripting,
  injection: Parameters<ChromeScripting["executeScript"]>[0]
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    try {
      const maybePromise = scripting.executeScript(injection, settle);
      if (isThenable(maybePromise)) maybePromise.then(settle, fail);
    } catch (error) {
      fail(error);
    }
  });
}

function sendRuntimeMessageSilently(
  runtime: Pick<ChromeRuntime, "sendMessage">,
  message: unknown
): void {
  try {
    const result = runtime.sendMessage?.(message);
    if (isPromiseLike(result)) void result.catch(() => undefined);
  } catch {
    // Progress messages are best-effort; never break the background workflow.
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof value === "object" && "catch" in value
    && typeof (value as { catch?: unknown }).catch === "function");
}

function isThenable(value: unknown): value is Promise<unknown> {
  return Boolean(value && typeof value === "object" && "then" in value
    && typeof (value as { then?: unknown }).then === "function");
}

const chromeApi = (globalThis as {
  chrome?: {
    runtime?: ChromeRuntime;
    storage?: ChromeStorage;
    tabs?: ChromeTabsApi;
    scripting?: ChromeScripting;
  };
}).chrome;
if (chromeApi?.runtime && chromeApi.storage && chromeApi.tabs) {
  registerBackground(chromeApi.runtime, chromeApi.storage, chromeApi.tabs, chromeApi.scripting);
}
