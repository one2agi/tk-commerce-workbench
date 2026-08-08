/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { SaveBar } from "../save-bar";

afterEach(() => {
  cleanup();
});

describe("SaveBar", () => {
  it("renders nothing when idle and no dirty fields", () => {
    const { container } = render(
      <SaveBar state="idle" error={null} dirtyCount={0} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(container.firstChild).toBeNull();
  });

  it("shows dirty count and version in dirty state", () => {
    render(
      <SaveBar state="idle" error={null} dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(screen.getByText(/已修改/)).toBeInTheDocument();
    expect(screen.getByText(/3/)).toBeInTheDocument();
    expect(screen.getByText(/v12/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "放弃更改" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "保存更改" })).toBeInTheDocument();
  });

  it("disables save button while saving", () => {
    render(
      <SaveBar state="saving" error={null} dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(screen.getByRole("button", { name: "正在保存更改…" })).toBeDisabled();
  });

  it("shows error state with red background and copy", () => {
    const { container } = render(
      <SaveBar state="error" error="保存失败，请稍后重试" dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(container.querySelector(".tk-save-bar.is-error")).not.toBeNull();
    expect(screen.getByText("保存失败，请稍后重试")).toBeInTheDocument();
  });

  it("shows conflict state with the actual version", () => {
    render(
      <SaveBar state="conflict" error="设置已被更新到版本 v7" dirtyCount={3} version={12} onDiscard={() => {}} onSave={() => {}} />
    );
    expect(screen.getByText(/v7/)).toBeInTheDocument();
  });

  it("invokes onDiscard and onSave callbacks", async () => {
    const user = userEvent.setup();
    const onDiscard = vi.fn();
    const onSave = vi.fn();
    render(
      <SaveBar state="idle" error={null} dirtyCount={1} version={12} onDiscard={onDiscard} onSave={onSave} />
    );
    await user.click(screen.getByRole("button", { name: "放弃更改" }));
    await user.click(screen.getByRole("button", { name: "保存更改" }));
    expect(onDiscard).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
