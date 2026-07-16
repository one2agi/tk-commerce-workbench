import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { useState } from "react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { fixtures } from "../../lib/fixtures";
import { ProductDrawer } from "./product-drawer";

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
});

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
});

async function testing() {
  const [{ render, screen }, { default: userEvent }] = await Promise.all([
    import("@testing-library/react"),
    import("@testing-library/user-event")
  ]);
  return { render, screen, user: userEvent.setup({ document: globalThis.document }) };
}

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

function SwitchingDrawerHarness() {
  const [index, setIndex] = useState<number | null>(null);
  const item = index === null ? null : fixtures.productPool[index]!;
  return <>
    <button type="button" onClick={() => setIndex(0)}>查看详情 A</button>
    <button type="button" onClick={() => setIndex(1)}>查看详情 B</button>
    <ProductDrawer
      item={item}
      open={item !== null}
      startButtonLabel="开始处理"
      startButtonEnabled
      onClose={() => setIndex(null)}
      onStart={vi.fn()}
    />
  </>;
}

describe("product drawer keyboard accessibility", () => {
  it("handles document Escape and returns focus to the detail trigger after close", async () => {
    const { render, screen, user } = await testing();
    render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "查看详情 892408514788" });

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("button", { name: "关闭详情" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  }, 60_000);

  it("returns focus to the detail trigger when an open drawer unmounts", async () => {
    const { render, screen, user } = await testing();
    const view = render(<DrawerHarness />);
    const trigger = screen.getByRole("button", { name: "查看详情 892408514788" });

    await user.click(trigger);
    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();
    view.rerender(<DrawerHarness mounted={false} />);

    expect(screen.queryByRole("button", { name: "关闭详情" })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  }, 60_000);

  it("returns focus to B after switching an open drawer directly from A to B", async () => {
    const { render, screen, user } = await testing();
    render(<SwitchingDrawerHarness />);
    const triggerA = screen.getByRole("button", { name: "查看详情 A" });
    const triggerB = screen.getByRole("button", { name: "查看详情 B" });
    const focusHistory: string[] = [];
    triggerA.addEventListener("focus", () => focusHistory.push("A"));
    triggerB.addEventListener("focus", () => focusHistory.push("B"));

    await user.click(triggerA);
    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();
    focusHistory.length = 0;
    await user.keyboard("{Shift>}{Tab}{/Shift}");
    expect(triggerB).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "关闭详情" })).toHaveFocus();
    expect(focusHistory).not.toContain("A");

    await user.keyboard("{Escape}");

    expect(triggerB).toHaveFocus();
    expect(triggerA).not.toHaveFocus();
  }, 60_000);
});
