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

describe("task recovery error handling", () => {
  it("keeps the recovery action usable and explains a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    const user = userEvent.setup();
    render(<TaskRecoveryActions taskId="job-1" status="failed" />);

    const retry = screen.getByRole("button", { name: "安全重试" });
    await user.click(retry);

    await waitFor(() => {
      expect(screen.getByRole("status")).toHaveTextContent("网络异常，操作未提交，请重试");
    });
    expect(retry).toBeEnabled();
  });
});
