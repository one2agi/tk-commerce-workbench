import { createSubmitter, type SubmitBatchInput, type SubmitResult } from "./submit-selected.js";

interface SubmitterLike {
  submitBatch(input: SubmitBatchInput): Promise<SubmitResult>;
}

interface SubmitSelectedMessage extends SubmitBatchInput {
  readonly kind: "submit-selected";
}

export function createSubmitSelectedHandler(submitter: SubmitterLike) {
  return (message: unknown, sendResponse: (response: unknown) => void): boolean => {
    if (!isSubmitSelectedMessage(message)) return false;
    void submitter
      .submitBatch({ batchId: message.batchId, items: message.items })
      .then(sendResponse)
      .catch(() =>
        sendResponse({ outcome: "paused", reason: "api_unavailable", items: message.items })
      );
    return true;
  };
}

function isSubmitSelectedMessage(message: unknown): message is SubmitSelectedMessage {
  if (!message || typeof message !== "object") return false;
  const value = message as Partial<SubmitSelectedMessage>;
  return (
    value.kind === "submit-selected" &&
    typeof value.batchId === "string" &&
    value.batchId.length > 0 &&
    Array.isArray(value.items)
  );
}

type ChromeRuntime = {
  onMessage: {
    addListener(
      listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean
    ): void;
  };
};

type ChromeStorage = Parameters<typeof createSubmitter>[0]["storage"];

export function registerBackground(runtime: ChromeRuntime, storage: ChromeStorage): void {
  const submitter = createSubmitter({ apiBase: "http://127.0.0.1:3000", storage });
  const handler = createSubmitSelectedHandler(submitter);
  runtime.onMessage.addListener((message, _sender, sendResponse) =>
    handler(message, sendResponse)
  );
}

const chromeApi = (globalThis as { chrome?: { runtime?: ChromeRuntime; storage?: ChromeStorage } }).chrome;
if (chromeApi?.runtime && chromeApi.storage) {
  registerBackground(chromeApi.runtime, chromeApi.storage);
}
