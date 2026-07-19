import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { cleanup, fireEvent, render } from "@testing-library/react";
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
    canonicalSourceTitle: "测试商品",
    targetTitle: null,
    canonicalSuccessDetailId: miaoshouDetailId("detail-1"),
    locale: "th-TH",
    currency: "CNY",
    priceWire: null,
    sourceImageCount: 6,
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

  it("disables the row start button while start is pending and shows 处理中 label", async () => {
    const { screen } = renderTable({
      item: item(),
      startStatus: "pending"
    });

    const startButton = screen.getByRole("button", {
      name: /处理中 892408514788/
    });
    expect(startButton).toBeDisabled();
  });

  it("disables the row start button after start succeeded and shows 已开始 label", async () => {
    const { screen } = renderTable({
      item: item(),
      startStatus: "success"
    });

    const startButton = screen.getByRole("button", {
      name: /已开始 892408514788/
    });
    expect(startButton).toBeDisabled();
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
    expect(screen.getByText(/妙手原始数据没有可用图片/)).toBeInTheDocument();
  });

  it("disables the row start button when canonical success detail id is missing", async () => {
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
    expect(startButton).toBeDisabled();
    expect(screen.getByText(/缺少妙手采集箱详情 ID/)).toBeInTheDocument();
  });

  it("disables the row start button when collect has not succeeded yet", async () => {
    const { screen } = renderTable({
      item: item({
        miaoshouSource: "pending",
        sourceImageCount: 4,
        canonicalSuccessDetailId: miaoshouDetailId("detail-1")
      })
    });

    const startButton = screen.getByRole("button", {
      name: /开始处理 892408514788/
    });
    expect(startButton).toBeDisabled();
    expect(screen.getByText(/采集尚未成功/)).toBeInTheDocument();
  });
});