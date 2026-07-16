// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { fixtures } from "../../lib/fixtures";
import { ProductDrawer } from "./product-drawer";

afterEach(cleanup);

function DrawerHarness({ mounted = true }: { mounted?: boolean }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" onClick={() => setOpen(true)}>查看详情 892408514788</button>
    {mounted ? <ProductDrawer
      item={fixtures.productPool[0]!}
      open={open}
      startButtonLabel="开始处理"
      startButtonEnabled
      onClose={() => setOpen(false)}
      onStart={vi.fn()}
    /> : null}
  </>;
}

describe("product drawer keyboard accessibility", () => {
  it("handles document Escape and returns focus to the detail trigger after close", async () => {
    const user = userEvent.setup();
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "查看详情 892408514788" });

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "关闭详情" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("returns focus to the detail trigger when an open drawer unmounts", async () => {
    const user = userEvent.setup();
    const view = render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "查看详情 892408514788" });

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();
    view.rerender(<DrawerHarness mounted={false} />);

    expect(screen.queryByRole("button", { name: "关闭详情" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
