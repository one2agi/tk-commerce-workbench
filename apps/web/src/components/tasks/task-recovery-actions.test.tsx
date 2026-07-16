// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TaskRecoveryActions } from "./task-recovery-actions";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("task recovery safety projection", () => {
  it.each(["fatal", "needs_input", "reconcile_required"] as const)(
    "does not expose safe retry for %s failures",
    (errorKind) => {
      render(<TaskRecoveryActions taskId="job-1" status="needs_input" errorKind={errorKind} />);
      expect(screen.queryByRole("button", { name: "安全重试" })).not.toBeInTheDocument();
    }
  );

  it("exposes safe retry only for a retryable failure in an allowed status", () => {
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);
    expect(screen.getByRole("button", { name: "安全重试" })).toBeEnabled();
  });

  it("describes reconcile-required state without claiming a remote task ID exists", () => {
    render(<TaskRecoveryActions taskId="job-1" status="needs_input" errorKind="reconcile_required" />);
    expect(screen.getByText("外部结果未知，仅允许人工对账")).toBeInTheDocument();
    expect(screen.queryByText(/已存在远端任务/)).not.toBeInTheDocument();
  });
});

describe("task recovery request handling", () => {
  it("keeps the recovery action usable and explains a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const user = userEvent.setup();
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);

    const retry = screen.getByRole("button", { name: "安全重试" });
    await user.click(retry);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("网络异常，操作未提交，请重试");
    });
    expect(retry).toBeEnabled();
  });

  it("shows a safe rejection message for an HTTP non-2xx response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 409 })));
    const user = userEvent.setup();
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);

    await user.click(screen.getByRole("button", { name: "安全重试" }));

    expect(await screen.findByRole("status")).toHaveTextContent("当前状态不允许此操作");
  });

  it("submits an action once while its first request is pending", async () => {
    const request = deferred<Response>();
    const fetcher = vi.fn(() => request.promise);
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
    render(<TaskRecoveryActions taskId="job-1" status="failed" errorKind="retryable" />);
    const retry = screen.getByRole("button", { name: "安全重试" });

    await user.dblClick(retry);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(retry).toBeDisabled();
    request.resolve(new Response(null, { status: 202 }));
    await waitFor(() => expect(retry).toBeEnabled());
  });

  it("does not let an older task response overwrite the current task message", async () => {
    const first = deferred<Response>();
    const second = deferred<Response>();
    const fetcher = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    vi.stubGlobal("fetch", fetcher);
    const user = userEvent.setup();
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
