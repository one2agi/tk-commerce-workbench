/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SettingsCard } from "../settings-card";

describe("SettingsCard", () => {
  it("renders title, hint, and body content", () => {
    render(
      <SettingsCard title="基础设置" hint="默认参数" ariaLabel="基础设置">
        <div>body</div>
      </SettingsCard>
    );
    expect(screen.getByRole("heading", { name: "基础设置" })).toBeInTheDocument();
    expect(screen.getByText("默认参数")).toBeInTheDocument();
    expect(screen.getByText("body")).toBeInTheDocument();
  });

  it("hides the dirty badge when dirtyCount is 0 or undefined", () => {
    const { rerender, container } = render(
      <SettingsCard title="A" ariaLabel="A">
        <div />
      </SettingsCard>
    );
    expect(container.querySelector(".tk-settings-card__dirty")).toBeNull();

    rerender(
      <SettingsCard title="A" dirtyCount={0} ariaLabel="A">
        <div />
      </SettingsCard>
    );
    expect(container.querySelector(".tk-settings-card__dirty")).toBeNull();
  });

  it("renders the dirty badge with count when dirtyCount > 0", () => {
    render(
      <SettingsCard title="定价" dirtyCount={3} ariaLabel="定价">
        <div />
      </SettingsCard>
    );
    expect(screen.getByText("已改 3 项")).toBeInTheDocument();
  });
});
