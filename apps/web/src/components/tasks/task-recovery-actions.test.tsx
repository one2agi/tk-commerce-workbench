import "@testing-library/jest-dom/vitest";
// @ts-expect-error The workspace provides the jsdom runtime without @types/jsdom.
import { JSDOM } from "jsdom";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

import { TaskRecoveryActions } from "./task-recovery-actions";

const domGlobals = [
  "window",
  "document",
  "navigator",
  "HTMLElement",
  "Node",
  "Event",
  "MouseEvent",
  "KeyboardEvent",
  "MutationObserver",
  "getComputedStyle"
] as const;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://127.0.0.1"
});
const values = {
  window: dom.window,
  document: dom.window.document,
  navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement,
  Node: dom.window.Node,
  Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent,
  KeyboardEvent: dom.window.KeyboardEvent,
  MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window)
};
for (const name of domGlobals) {
  originalGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
  Object.defineProperty(globalThis, name, { value: values[name], configurable: true });
}

const [{ render, screen, waitFor }, { default: userEvent }] = await Promise.all([
  import("@testing-library/react"),
  import("@testing-library/user-event")
]);

afterEach(async () => {
  const { cleanup } = await import("@testing-library/react");
  cleanup();
  vi.unstubAllGlobals();
});

afterAll(() => {
  for (const name of domGlobals) {
    const descriptor = originalGlobals.get(name);
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.window.close();
});

function testing() {
  return { render, screen, waitFor, userEvent };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("task recovery safety projection", () => {
  it.each(["fatal", "needs_input", "reconcile_required"] as const)(
    "does not expose safe retry for %s failures",
    async (errorKind) => {
      const { render, screen } = await testing();
      render(<TaskRecoveryActions taskId="job-1" status="needs_input" errorKind={errorKind} />);
      expect(screen.queryByRole("button", { name: "安全重试" })).not.toBeInTheDocument();
    }
  );

  it("exposes safe retry only for a retryable failure in an allowed status", async () => {
    const { render, screen } = await testing();
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);
    expect(screen.getByRole("button", { name: "安全重试" })).toBeEnabled();
  });

  it("describes reconcile-required state without claiming a remote task ID exists", async () => {
    const { render, screen } = await testing();
    render(<TaskRecoveryActions taskId="job-1" status="needs_input" errorKind="reconcile_required" />);
    expect(screen.getByText("外部结果未知，仅允许人工对账")).toBeInTheDocument();
    expect(screen.queryByText(/已存在远端任务/)).not.toBeInTheDocument();
  });
});

describe("task recovery request handling", () => {
  it("keeps the recovery action usable and explains a network failure", async () => {
    const { render, screen, waitFor, userEvent } = await testing();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const user = userEvent.setup({ document: globalThis.document });
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);

    const retry = screen.getByRole("button", { name: "安全重试" });
    await user.click(retry);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("网络异常，操作未提交，请重试");
    });
    expect(retry).toBeEnabled();
  });

  it("shows a safe rejection message for an HTTP non-2xx response", async () => {
    const { render, screen, userEvent } = await testing();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 409 })));
    const user = userEvent.setup({ document: globalThis.document });
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);

    await user.click(screen.getByRole("button", { name: "安全重试" }));

    expect(await screen.findByRole("status")).toHaveTextContent("当前状态不允许此操作");
  });

  it("submits an action once while its first request is pending", async () => {
    const { render, screen, waitFor, userEvent } = await testing();
    const request = deferred<Response>();
    const fetcher = vi.fn(() => request.promise);
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup({ document: globalThis.document });
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);
    const retry = screen.getByRole("button", { name: "安全重试" });

    await user.dblClick(retry);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(retry).toBeDisabled();
    request.resolve(new Response(null, { status: 202 }));
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it("does not let an older task response overwrite the current task message", async () => {
    const { render, screen, waitFor, userEvent } = await testing();
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup({ document: globalThis.document });
    const view = render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);
    await user.click(screen.getByRole("button", { name: "安全重试" }));

    view.rerender(<TaskRecoveryActions taskId="job-2" status="failed" errorKind="retryable" />);
    const currentRetry = screen.getByRole("button", { name: "安全重试" });
    await waitFor(() => expect(currentRetry).toBeEnabled());
    await user.click(currentRetry);
    second.resolve(new Response(null, { status: 202 }));
    await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("操作已受理"));

    first.resolve(new Response(null, { status: 409 }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.getByRole("status")).toHaveTextContent("操作已受理");
  });
});
