// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtures } from "../../lib/fixtures";
import { ProductDrawer } from "./product-drawer";

afterEach(cleanup);

function renderOpenDrawer(onClose = vi.fn()) {
  render(
    <ProductDrawer
      item={fixtures.productPool[0]!}
      open
      startButtonLabel="开始处理"
      startButtonEnabled
      onClose={onClose}
      onStart={vi.fn()}
    />
  );
  return onClose;
}

describe("product drawer keyboard accessibility", () => {
  it("moves keyboard focus to the close control when the drawer opens", () => {
    renderOpenDrawer();

    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();
  });

  it("closes the drawer when a keyboard user presses Escape", () => {
    const onClose = renderOpenDrawer();

    fireEvent.keyDown(screen.getByRole("dialog", { name: "商品详情" }), {
      key: "Escape"
    });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
