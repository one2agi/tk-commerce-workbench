import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { ApprovalActions, type ReviewActions } from "./approval-actions";

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

describe("approval action submission safety", () => {
  it("submits the Miaoshou confirmation at most once while the first request is pending", async () => {
    const [{ render, screen, waitFor }, { default: userEvent }] = await Promise.all([
      import("@testing-library/react"),
      import("@testing-library/user-event")
    ]);
    let resolveConfirm!: (value: Record<string, unknown>) => void;
    const confirm = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      resolveConfirm = resolve;
    }));
    const actions: ReviewActions = {
      updateDraft: vi.fn(),
      rerun: vi.fn(),
      confirm,
      retryMiaoshouEdit: vi.fn()
    };
    const user = userEvent.setup({ document: globalThis.document });
    render(
      <ApprovalActions
        productId="product-1"
        revisionId="revision-1"
        draftVersion={1}
        listingRunId="listing-1"
        templateVersion={1}
        orderedFinalAssetIds={["asset-1"]}
        targetLocale="th-TH"
        translationStyle="marketplace"
        actions={actions}
      />
    );

    const button = screen.getByRole("button", { name: "确认写回妙手" });
    await user.dblClick(button);

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();

    resolveConfirm({});
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("已进入妙手同步队列"));
    expect(screen.queryByRole("button", { name: "确认写回妙手" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "正在写回妙手" })).toBeDisabled();
  }, 60_000);

  it.each([
    ["async rejection", () => Promise.reject(new Error("offline"))],
    ["synchronous throw", () => { throw new Error("broken action"); }]
  ])("unlocks confirmation and exposes an error after %s", async (_label, fail) => {
    const [{ render, screen, waitFor }, { default: userEvent }] = await Promise.all([
      import("@testing-library/react"),
      import("@testing-library/user-event")
    ]);
    const actions: ReviewActions = {
      updateDraft: vi.fn(),
      rerun: vi.fn(),
      confirm: vi.fn(fail),
      retryMiaoshouEdit: vi.fn()
    };
    const user = userEvent.setup({ document: globalThis.document });
    render(<ApprovalActions
      productId="product-1"
      revisionId="revision-1"
      draftVersion={1}
      listingRunId="listing-1"
      templateVersion={1}
      orderedFinalAssetIds={["asset-1"]}
      targetLocale="th-TH"
      translationStyle="marketplace"
      actions={actions}
    />);
    const button = screen.getByRole("button", { name: "确认写回妙手" });

    await user.click(button);

    await waitFor(() => expect(button).toBeEnabled());
    expect(screen.getByRole("status")).toHaveTextContent("确认失败，请刷新版本后重试");
  }, 60_000);

  it("shows explicit no-change status and submits a manual retry at most once", async () => {
    const [{ render, screen, waitFor }, { default: userEvent }] = await Promise.all([
      import("@testing-library/react"),
      import("@testing-library/user-event")
    ]);
    let resolveRetry!: (value: Record<string, unknown>) => void;
    const retryMiaoshouEdit = vi.fn(() => new Promise<Record<string, unknown>>((resolve) => {
      resolveRetry = resolve;
    }));
    const actions: ReviewActions = {
      updateDraft: vi.fn(),
      rerun: vi.fn(),
      confirm: vi.fn(),
      retryMiaoshouEdit
    };
    const user = userEvent.setup({ document: globalThis.document });
    render(<ApprovalActions
      productId="product-1"
      revisionId="revision-1"
      draftVersion={1}
      listingRunId="listing-1"
      templateVersion={1}
      orderedFinalAssetIds={["asset-1"]}
      targetLocale="th-TH"
      translationStyle="marketplace"
      miaoshouWriteback={{
        state: "result_unknown",
        failureCode: "miaoshou_reconcile_no_change",
        safeMessage: "remote unchanged",
        retryAllowed: true,
        approvalSnapshotId: "approval-1"
      }}
      actions={actions}
    />);

    expect(screen.getByRole("status")).toHaveTextContent("妙手写回未生效，远端仍为原内容");
    expect(screen.queryByRole("button", { name: "确认写回妙手" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "重新写回妙手" });
    await user.dblClick(button);

    expect(retryMiaoshouEdit).toHaveBeenCalledTimes(1);
    expect(button).toBeDisabled();
    resolveRetry({});
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("正在写回妙手"));
  }, 60_000);

  it("shows an unknown-result warning without exposing retry for unproven failures", async () => {
    const { render, screen } = await import("@testing-library/react");
    render(<ApprovalActions
      productId="product-1"
      revisionId="revision-1"
      draftVersion={1}
      listingRunId="listing-1"
      templateVersion={1}
      orderedFinalAssetIds={["asset-1"]}
      targetLocale="th-TH"
      translationStyle="marketplace"
      miaoshouWriteback={{
        state: "result_unknown",
        failureCode: "miaoshou.network",
        safeMessage: "result unknown",
        retryAllowed: false,
        approvalSnapshotId: "approval-1"
      }}
      actions={{
        updateDraft: vi.fn(), rerun: vi.fn(), confirm: vi.fn(), retryMiaoshouEdit: vi.fn()
      }}
    />);

    expect(screen.getByRole("status")).toHaveTextContent("妙手写回结果未知，需要人工核对");
    expect(screen.queryByRole("button", { name: "重新写回妙手" })).not.toBeInTheDocument();
  });
});
