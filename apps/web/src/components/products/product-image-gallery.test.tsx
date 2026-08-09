import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ProductImageGallery } from "./product-image-gallery";

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1"
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node,
    MouseEvent: dom.window.MouseEvent,
    KeyboardEvent: dom.window.KeyboardEvent
  })) {
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
}, 30000);

vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

afterEach(() => {
  cleanup();
});

function renderGallery(overrides: {
  originalImageUrls?: string[];
  processedImageUrls?: string[];
  selectedOriginalAssetIds?: ReadonlySet<string>;
  onToggleOriginal?: (assetId: string) => void;
} = {}) {
  const originalImageUrls = overrides.originalImageUrls ?? ["/source-1.jpg", "/source-2.jpg", "/source-3.jpg"];
  const processedImageUrls = overrides.processedImageUrls ?? ["/washed-1.jpg", "/washed-2.jpg"];
  return render(
    <ProductImageGallery
      productId="prod-1"
      originalImages={originalImageUrls.map((url, index) => ({
        key: `source-${index + 1}`,
        url,
        assetId: `asset-${index + 1}`,
        selectable: true
      }))}
      processedImages={processedImageUrls.map((url, index) => ({
        key: `washed-${index + 1}`,
        url,
        assetId: `generated-${index + 1}`,
        selectable: false
      }))}
      selectedOriginalAssetIds={overrides.selectedOriginalAssetIds ?? new Set()}
      onToggleOriginal={overrides.onToggleOriginal}
    />
  );
}

describe("ProductImageGallery", () => {
  it("shows all collected and processed images in separate visible regions", () => {
    const screen = renderGallery();

    expect(screen.getByRole("region", { name: "商品 prod-1 原产品图" }))
      .toHaveTextContent("原产品图3");
    expect(screen.getByRole("region", { name: "商品 prod-1 洗图后的图" }))
      .toHaveTextContent("洗图后的图2");
    expect(screen.getAllByRole("button", { name: /放大原产品图/ })).toHaveLength(3);
    expect(screen.getAllByRole("button", { name: /放大洗图后的图/ })).toHaveLength(2);
  });

  it("previews only the selected section and restores focus after keyboard close", () => {
    const screen = renderGallery();
    const opener = screen.getByRole("button", { name: "放大原产品图 1/3" });

    fireEvent.click(opener);
    expect(screen.getByRole("dialog", { name: "原产品图预览" })).toBeInTheDocument();
    expect(screen.getByText("1 / 3")).toBeInTheDocument();
    expect(screen.queryByText("1 / 2")).toBeNull();

    fireEvent.keyDown(document, { key: "ArrowRight" });
    expect(screen.getByText("2 / 3")).toBeInTheDocument();

    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(opener).toHaveFocus();
  });

  it("uses a separate checkbox to select a local source image without opening preview", () => {
    const onToggleOriginal = vi.fn();
    const screen = renderGallery({
      selectedOriginalAssetIds: new Set(["asset-1"]),
      onToggleOriginal
    });

    const checkbox = screen.getByRole("checkbox", { name: "选作洗图输入 原产品图 1" });
    expect(checkbox).toBeChecked();
    fireEvent.click(screen.getByRole("checkbox", { name: "选作洗图输入 原产品图 2" }));
    expect(onToggleOriginal).toHaveBeenCalledWith("asset-2");
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("shows explicit empty states without requiring a detail-page click", () => {
    const screen = renderGallery({
      originalImageUrls: [],
      processedImageUrls: []
    });

    expect(screen.getByText("未采集到可用原图")).toBeInTheDocument();
    expect(screen.getByText("等待生成")).toBeInTheDocument();
  });

  it("keeps sibling images visible when one tile fails", () => {
    const screen = renderGallery({ processedImageUrls: [] });

    fireEvent.error(screen.getByRole("img", { name: "原产品图 1" }));

    expect(screen.getByText("图片加载失败")).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "原产品图 2" })).toBeInTheDocument();
    expect(screen.getByRole("img", { name: "原产品图 3" })).toBeInTheDocument();
  });
});
