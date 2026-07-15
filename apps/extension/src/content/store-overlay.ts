// Floating preview overlay for the 1688 store listing. Renders a small
// floating panel listing scanned cards with selection checkboxes. Selected
// only is what gets handed to the background service worker for submission.

import type { ScanStore, ScannedCard } from "./scan-store.js";

export interface OverlayHandle {
  mount(store: ScanStore, host: HTMLElement): void;
  unmount(): void;
}

export function createStoreOverlay(): OverlayHandle {
  let store: ScanStore | null = null;
  let panel: HTMLDivElement | null = null;
  let unsub: (() => void) | null = null;
  let batchId = createBatchId();
  let feedback = "";
  let retryBatch: ReturnType<typeof createSubmitSelectedMessage> | null = null;

  function render(): void {
    if (!store || !panel) return;
    const cards = store.snapshot();
    const sel = store.selection();
    panel.innerHTML = "";
    const title = document.createElement("div");
    title.textContent = `已扫描 ${cards.length} 个商品，已选 ${sel.size}`;
    panel.appendChild(title);
    if (feedback) {
      const status = document.createElement("div");
      status.dataset.tkSubmitStatus = "true";
      status.textContent = feedback;
      panel.appendChild(status);
    }
    for (const c of cards) {
      const row = document.createElement("label");
      row.style.display = "block";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = sel.has(c.sourceItemId);
      cb.addEventListener("change", () => store!.select(c.sourceItemId, cb.checked));
      row.appendChild(cb);
      row.appendChild(document.createTextNode(` ${c.sourceItemId} ${c.title}`));
      panel.appendChild(row);
    }
    const submitButton = document.createElement("button");
    submitButton.type = "button";
    submitButton.textContent = `提交已选 (${sel.size})`;
    submitButton.disabled = sel.size === 0;
    submitButton.addEventListener("click", () => {
      void submitMessage(createSubmitSelectedMessage(batchId, store!.selectedBatch()));
    });
    panel.appendChild(submitButton);
    if (retryBatch) {
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = `重试待提交批次 (${retryBatch.items.length})`;
      retry.addEventListener("click", () => void submitMessage(retryBatch!));
      panel.appendChild(retry);
    }
  }

  async function submitMessage(message: ReturnType<typeof createSubmitSelectedMessage>): Promise<void> {
    const runtime = getRuntime();
    if (!runtime) {
      feedback = "扩展后台不可用，待恢复后重试";
      retryBatch = message;
      render();
      return;
    }
    feedback = "正在提交…";
    render();
    const response = await sendSubmission(runtime, message);
    if (response?.outcome === "submitted") {
      feedback = `已提交 ${response.accepted ?? message.items.length} 个商品`;
      retryBatch = null;
    } else {
      feedback = response?.reason === "missing_token" ? "请先在扩展设置中填写访问令牌" : "提交暂停，可安全重试";
      retryBatch = message;
    }
    render();
  }

  return {
    mount(s, h) {
      batchId = createBatchId();
      store = s;
      panel = document.createElement("div");
      panel.dataset.tkOverlay = "store-listing";
      panel.style.position = "fixed";
      panel.style.right = "12px";
      panel.style.bottom = "12px";
      panel.style.zIndex = "2147483646";
      panel.style.maxHeight = "50vh";
      panel.style.overflow = "auto";
      panel.style.background = "white";
      panel.style.border = "1px solid #ccc";
      panel.style.padding = "8px";
      panel.style.fontSize = "12px";
      h.appendChild(panel);
      unsub = store.subscribe(() => render());
      render();
      const runtime = getRuntime();
      runtime?.sendMessage({ kind: "get-paused-submission" }, (saved) => {
        if (isSavedBatch(saved)) {
          retryBatch = createSubmitSelectedMessage(saved.batchId, saved.items);
          feedback = "检测到上次未提交完成的批次";
          render();
        }
      });
    },
    unmount() {
      unsub?.();
      unsub = null;
      panel?.remove();
      panel = null;
      store = null;
    }
  };
}

type SubmissionResponse = { outcome?: "submitted" | "paused"; accepted?: number; reason?: string } | null;
export type ExtensionRuntime = { sendMessage(message: unknown, callback: (response: unknown) => void): void };

export function sendSubmission(
  runtime: ExtensionRuntime,
  message: ReturnType<typeof createSubmitSelectedMessage>
): Promise<SubmissionResponse> {
  return new Promise((resolve) => runtime.sendMessage(message, (response) => resolve((response ?? null) as SubmissionResponse)));
}

function getRuntime(): ExtensionRuntime | null {
  return (globalThis as { chrome?: { runtime?: ExtensionRuntime } }).chrome?.runtime ?? null;
}

function isSavedBatch(value: unknown): value is { batchId: string; items: ScannedCard[] } {
  if (!value || typeof value !== "object") return false;
  const saved = value as { batchId?: unknown; items?: unknown };
  return typeof saved.batchId === "string" && Array.isArray(saved.items);
}

export function createSubmitSelectedMessage(
  batchId: string,
  items: ReadonlyArray<ScannedCard>
) {
  return Object.freeze({ kind: "submit-selected" as const, batchId, items });
}

function createBatchId(): string {
  const random =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `batch_${random}`;
}
