// Floating preview overlay for the 1688 store listing. Renders a small
// floating panel listing scanned cards with selection checkboxes. Selected
// only is what gets handed to the background service worker for submission.

import type { ScanStore, ScannedCard } from "./scan-store.js";

export interface OverlayHandle {
  mount(store: ScanStore, host: HTMLElement): void;
  unmount(): void;
}

export function createStoreOverlay(): OverlayHandle {
  let host: HTMLElement | null = null;
  let store: ScanStore | null = null;
  let panel: HTMLDivElement | null = null;
  let unsub: (() => void) | null = null;

  function render(): void {
    if (!store || !panel) return;
    const cards = store.snapshot();
    const sel = store.selection();
    panel.innerHTML = "";
    const title = document.createElement("div");
    title.textContent = `已扫描 ${cards.length} 个商品，已选 ${sel.size}`;
    panel.appendChild(title);
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
    const submit = document.createElement("button");
    submit.type = "button";
    submit.textContent = `提交已选 (${sel.size})`;
    submit.disabled = sel.size === 0;
    submit.addEventListener("click", () => {
      const batch = store!.selectedBatch();
      // Send the selected-only batch to the background service worker.
      const chromeApi = (globalThis as { chrome?: { runtime?: { sendMessage: (msg: unknown) => void } } }).chrome;
      chromeApi?.runtime?.sendMessage({ kind: "submit-selected", items: batch });
    });
    panel.appendChild(submit);
  }

  return {
    mount(s, h) {
      store = s;
      host = h;
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
    },
    unmount() {
      unsub?.();
      unsub = null;
      panel?.remove();
      panel = null;
      host = null;
      store = null;
    }
  };
}