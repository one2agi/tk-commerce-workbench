/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { StatusPill } from "../status-pill";

describe("StatusPill", () => {
  it("renders configured state with checkmark and green class", () => {
    const { container } = render(
      <StatusPill name="妙手" envVars="MIAOSHOU_APP_KEY / _SECRET" configured />
    );
    expect(screen.getByText("妙手")).toBeInTheDocument();
    expect(screen.getByText("MIAOSHOU_APP_KEY / _SECRET")).toBeInTheDocument();
    expect(container.querySelector(".tk-pill.is-ok")).not.toBeNull();
    expect(container.querySelector(".tk-pill.is-warn")).toBeNull();
  });

  it("renders not-configured state with warning icon and amber class", () => {
    const { container } = render(
      <StatusPill name="汇率" envVars="EXCHANGE_RATE_API_KEY" configured={false} />
    );
    expect(container.querySelector(".tk-pill.is-warn")).not.toBeNull();
    expect(container.querySelector(".tk-pill.is-ok")).toBeNull();
  });
});
