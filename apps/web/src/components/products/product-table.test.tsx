import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  miaoshouDetailId,
  productId,
  productRevisionId,
  sourceItemId
} from "@tk/contracts/ids";
import type { ProductPoolItemV1 } from "@tk/contracts/read-models";

import { ProductTable } from "./product-table";

beforeAll(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://127.0.0.1"
  });
  for (const [name, value] of Object.entries({
    window: dom.window,
    document: dom.window.document,
    navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement,
    Node: dom.window.Node
  })) {
    Object.defineProperty(globalThis, name, { value, configurable: true });
  }
}, 30000);

// The first test file import includes the cold @testing-library/react load,
// which takes several seconds under the workspace's pnpm cache. Keep a
// generous timeout so the suite is robust regardless of cache temperature.
vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

afterEach(() => {
  cleanup();
});

function item(overrides: Partial<ProductPoolItemV1> = {}): ProductPoolItemV1 {
  return {
    productId: productId("892408514788"),
    currentRevisionId: productRevisionId("revision-892408514788"),
    sourceItemId: sourceItemId("s-1"),
    sourceUrl: "https://detail.1688.com/offer/892408514788.html",
    thumbnailUrl: "https://img.test/892408514788.jpg",
    originalImageUrls: ["https://img.test/892408514788.jpg"],
    processedImageUrls: [],
    collectedAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T10:10:00.000Z",
    canonicalSourceTitle: "测试商品",
    targetTitle: null,
    canonicalSuccessDetailId: miaoshouDetailId("detail-1"),
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    sourceImageCount: 6,
    sourceCaptureQuality: null,
    imageCount: 0,
    usableCanvasOutputCount: 0,
    miaoshouSource: "success",
    automation: "not_started",
    assetArchive: "pending",
    listing: "pending",
    canvas: "not_started",
    approval: "unapproved",
    miaoshouEdit: "not_started",
    warningCodes: [],
    ...overrides
  };
}

function renderTable(props: {
  item: ProductPoolItemV1;
  onStart?: (productId: string) => void;
  startStatus?: "idle" | "pending" | "success" | "failure";
}) {
  const onStart = props.onStart ?? vi.fn();
  const startStatusById = new Map<string, "idle" | "pending" | "success" | "failure">([
    [String(props.item.productId), props.startStatus ?? "idle"]
  ]);
  const view = render(
    <ProductTable
      items={[props.item]}
      filtered={[props.item]}
      selectedIds={new Set()}
      startStatusById={startStatusById}
      activeStage="all"
      onToggleSelection={vi.fn()}
      onOpenDrawer={vi.fn()}
      onScroll={vi.fn()}
      scrollTop={0}
      onStart={onStart}
    />
  );
  return { screen: view, onStart };
}

describe("ProductTable row-level start action", () => {
  it("shows the collected CNY source price and blocks partial local captures", () => {
    const { screen } = renderTable({
      item: item({
        sourcePriceWire: { amountMinor: "1350", currency: "CNY" },
        sourceCaptureQuality: "detail_page_partial",
        miaoshouSource: "local_captured",
        canonicalSuccessDetailId: null
      })
    });

    expect(screen.getByText("¥13.50")).toBeInTheDocument();
    expect(screen.getAllByText("本地采集不完整，请重新采集").length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button", { name: /开始处理 892408514788/ })).toHaveLength(0);
    expect(screen.getByRole("link", { name: /查看原因 892408514788/ })).toBeInTheDocument();
  });

  it("opens the product detail image review page from image and View action", () => {
    const { screen } = renderTable({
      item: item({
        thumbnailUrl: "https://img.test/main.jpg",
        automation: "ready",
        assetArchive: "ready",
        listing: "ready",
        canvas: "succeeded",
        usableCanvasOutputCount: 5,
        targetTitle: "สร้อยคอจี้โคลเวอร์"
      })
    });

    expect(screen.getByRole("link", { name: /查看商品图片 892408514788/ })).toHaveAttribute("href", "/products/892408514788");
    expect(screen.getByRole("link", { name: /查看并确认 892408514788/ })).toHaveAttribute("href", "/products/892408514788");
  });

  it("renders the original 1688 CDN thumbnail returned by the product API", () => {
    const originalImage = "https://cbu01.alicdn.com/img/ibank/O1CN01jvaVp11Bx5Oi48xYl_!!2212215930011-0-cib.jpg";
    const { screen } = renderTable({
      item: item({
        thumbnailUrl: originalImage
      })
    });

    expect(screen.getByRole("img", { name: "商品缩略图" })).toHaveAttribute("src", originalImage);
    expect(screen.queryByText("图")).toBeNull();
  });

  it("shows original and processed galleries under the matching product row", () => {
    const { screen } = renderTable({
      item: item({
        originalImageUrls: ["/source-1.jpg", "/source-2.jpg"],
        processedImageUrls: ["/canvas-1.jpg"]
      })
    });

    const productGallery = screen.getByRole("group", {
      name: "商品 892408514788 图片"
    });
    expect(within(productGallery).getByRole("region", {
      name: "商品 892408514788 原产品图"
    })).toBeInTheDocument();
    expect(within(productGallery).getByRole("region", {
      name: "商品 892408514788 洗图后的图"
    })).toBeInTheDocument();
    expect(within(productGallery).getAllByRole("button", {
      name: /放大原产品图/
    })).toHaveLength(2);
    expect(screen.getByRole("link", { name: /查看详情 892408514788/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /开始处理 892408514788/ })).toBeInTheDocument();
  });

  it("shows a row-level start button for a collected product before local assets are archived", async () => {
    const { screen, onStart } = renderTable({
      item: item()
    });

    const startButton = screen.getByRole("button", {
      name: /开始处理 892408514788/
    });
    expect(startButton).toBeEnabled();

    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledWith("892408514788");
  });

  it("shows a progress link while start is pending", async () => {
    const { screen } = renderTable({
      item: item(),
      startStatus: "pending"
    });

    expect(screen.getByRole("link", { name: /查看进度 892408514788/ })).toHaveAttribute("href", "/products/892408514788");
    expect(screen.queryByRole("button", { name: /处理中 892408514788/ })).toBeNull();
  });

  it("shows a progress link after start succeeded", async () => {
    const { screen } = renderTable({
      item: item(),
      startStatus: "success"
    });

    expect(screen.getByRole("link", { name: /查看进度 892408514788/ })).toHaveAttribute("href", "/products/892408514788");
    expect(screen.queryByRole("button", { name: /已开始 892408514788/ })).toBeNull();
  });

  it("shows 重试处理 label and keeps the button enabled after a previous failure", async () => {
    const { screen, onStart } = renderTable({
      item: item(),
      startStatus: "failure"
    });

    const startButton = screen.getByRole("button", {
      name: /重试处理 892408514788/
    });
    expect(startButton).toBeEnabled();

    fireEvent.click(startButton);
    expect(onStart).toHaveBeenCalledWith("892408514788");
  });

  it("disables the row start button and explains the reason when source has no images", async () => {
    const { screen } = renderTable({
      item: item({
        sourceImageCount: 0,
        imageCount: 0,
        canonicalSuccessDetailId: miaoshouDetailId("detail-1"),
        miaoshouSource: "success"
      })
    });

    const startButton = screen.getByRole("button", {
      name: /开始处理 892408514788/
    });
    expect(startButton).toBeDisabled();
    expect(screen.getAllByText(/1688 详情数据没有可用图片/).length).toBeGreaterThan(0);
  });

  it("allows processing before the late Miaoshou detail id is created", async () => {
    const { screen } = renderTable({
      item: item({
        canonicalSuccessDetailId: null,
        sourceImageCount: 4,
        imageCount: 0,
        miaoshouSource: "skipped_duplicate"
      })
    });

    const startButton = screen.getByRole("button", {
      name: /开始处理 892408514788/
    });
    expect(startButton).toBeEnabled();
    expect(screen.queryByText(/缺少妙手采集箱详情 ID/)).toBeNull();
  });

  it("disables the row start button when collect has not succeeded yet", async () => {
    const { screen } = renderTable({
      item: item({
        miaoshouSource: "pending",
        sourceImageCount: 4,
        canonicalSuccessDetailId: miaoshouDetailId("detail-1")
      })
    });

    expect(screen.getByRole("link", { name: /查看进度 892408514788/ })).toHaveAttribute("href", "/products/892408514788");
    expect(screen.queryByRole("button", { name: /开始处理 892408514788/ })).toBeNull();
  });
});
