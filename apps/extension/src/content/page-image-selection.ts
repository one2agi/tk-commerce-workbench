import {
  findScannedCardTargets,
  type ScanStore,
  type ScannedCardTarget
} from "./scan-store.js";

const CONTROL_ATTR = "data-tk-image-select";
const STYLE_ID = "tk-image-selection-style";

export function installPageImageSelectionControls(store: ScanStore, root: HTMLElement): () => void {
  ensureStyle();
  const render = () => renderSelectionControls(store, root);
  const unsubscribe = store.subscribe(render);
  render();
  return () => {
    unsubscribe();
    for (const control of Array.from(root.querySelectorAll(`[${CONTROL_ATTR}]`))) {
      control.remove();
    }
  };
}

function renderSelectionControls(store: ScanStore, root: HTMLElement): void {
  const targets = findScannedCardTargets(root);
  const seen = new Set<string>();
  const selection = store.selection();
  for (const target of targets) {
    seen.add(target.sourceItemId);
    const host = selectionHost(target);
    makeControlHost(host);
    let control = host.querySelector<HTMLButtonElement>(
      `[${CONTROL_ATTR}][data-source-item-id="${target.sourceItemId}"]`
    );
    if (!control) {
      control = document.createElement("button");
      control.type = "button";
      control.textContent = "✓";
      control.setAttribute(CONTROL_ATTR, "true");
      control.dataset.sourceItemId = target.sourceItemId;
      control.className = "tk-image-select-control";
      control.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const selected = store.selection().has(target.sourceItemId);
        store.select(target.sourceItemId, !selected);
      });
      host.appendChild(control);
    }
    reflectSelected(control, selection.has(target.sourceItemId));
  }
  for (const stale of Array.from(root.querySelectorAll<HTMLButtonElement>(`[${CONTROL_ATTR}]`))) {
    const sourceItemId = stale.dataset.sourceItemId;
    if (!sourceItemId || !seen.has(sourceItemId)) stale.remove();
  }
}

function selectionHost(target: ScannedCardTarget): HTMLElement {
  const linkedImageHost = target.imageElement?.closest<HTMLElement>("a[href], [data-href]");
  return linkedImageHost ?? target.cardElement;
}

function makeControlHost(host: HTMLElement): void {
  const style = host.style;
  if (!style.position || style.position === "static") style.position = "relative";
  if (!style.display) style.display = "inline-block";
}

function reflectSelected(control: HTMLButtonElement, selected: boolean): void {
  control.setAttribute("aria-label", selected ? "取消选中该商品" : "选中该商品");
  control.setAttribute("aria-pressed", selected ? "true" : "false");
  control.dataset.selected = selected ? "true" : "false";
  control.title = selected ? "已选中，点击取消" : "点击选中该商品";
}

function ensureStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .tk-image-select-control {
      position: absolute;
      top: 8px;
      right: 8px;
      z-index: 2147483645;
      width: 24px;
      height: 24px;
      border-radius: 999px;
      border: 2px solid #ffffff;
      background: rgba(17, 24, 39, 0.72);
      color: #ffffff;
      font-size: 15px;
      line-height: 18px;
      font-weight: 700;
      box-shadow: 0 2px 8px rgba(15, 23, 42, 0.28);
      cursor: pointer;
      opacity: 0.88;
    }
    .tk-image-select-control:hover {
      opacity: 1;
      transform: scale(1.04);
    }
    .tk-image-select-control[data-selected="true"] {
      background: #16a34a;
      border-color: #dcfce7;
      box-shadow: 0 0 0 3px rgba(34, 197, 94, 0.28), 0 2px 8px rgba(15, 23, 42, 0.28);
    }
  `;
  document.documentElement.appendChild(style);
}
