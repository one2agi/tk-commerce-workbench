import { describe, expect, it } from "vitest";
import { createScanStore } from "./scan-store.js";
import { installPageImageSelectionControls } from "./page-image-selection.js";

function renderSearchPage(): HTMLElement {
  document.body.innerHTML = `
    <main>
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/111111111111.html">
        <img src="https://img.example.test/111.jpg" alt="商品图 111">
        <span class="title-text">商品 111</span>
      </a>
      <a class="search-offer-wrapper" href="https://detail.1688.com/offer/222222222222.html">
        <img src="https://img.example.test/222.jpg" alt="商品图 222">
        <span class="title-text">商品 222</span>
      </a>
    </main>
  `;
  return document.body;
}

describe("page image selection controls", () => {
  it("adds a top-right selection checkbox to each scanned product image", () => {
    const root = renderSearchPage();
    const store = createScanStore(root);
    const cleanup = installPageImageSelectionControls(store, root);
    try {
      store.rescan();

      const controls = Array.from(document.querySelectorAll("[data-tk-image-select]"));
      expect(controls.map((control) => control.getAttribute("data-source-item-id"))).toEqual([
        "111111111111",
        "222222222222"
      ]);
      expect(controls.every((control) => control.textContent?.trim() === "✓")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("selects from the image checkbox without navigating the 1688 image link", () => {
    const root = renderSearchPage();
    const store = createScanStore(root);
    const cleanup = installPageImageSelectionControls(store, root);
    try {
      store.rescan();
      const control = document.querySelector<HTMLButtonElement>("[data-source-item-id='111111111111']");
      expect(control).not.toBeNull();

      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      const dispatchResult = control!.dispatchEvent(event);

      expect(dispatchResult).toBe(false);
      expect(event.defaultPrevented).toBe(true);
      expect(store.selection()).toEqual(new Set(["111111111111"]));
      expect(control!.getAttribute("aria-pressed")).toBe("true");
    } finally {
      cleanup();
    }
  });

  it("does not intercept normal product image clicks outside the checkbox", () => {
    const root = renderSearchPage();
    const store = createScanStore(root);
    const cleanup = installPageImageSelectionControls(store, root);
    try {
      store.rescan();
      const link = document.querySelector<HTMLAnchorElement>("a.search-offer-wrapper");
      expect(link).not.toBeNull();

      const event = new MouseEvent("click", { bubbles: true, cancelable: true });
      const dispatchResult = link!.dispatchEvent(event);

      expect(dispatchResult).toBe(true);
      expect(event.defaultPrevented).toBe(false);
      expect(store.selection()).toEqual(new Set());
    } finally {
      cleanup();
    }
  });
});
