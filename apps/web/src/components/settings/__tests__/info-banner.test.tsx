/** @vitest-environment jsdom */
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { InfoBanner } from "../info-banner";

describe("InfoBanner", () => {
  it("renders the running-worker rule", () => {
    render(<InfoBanner />);
    expect(
      screen.getByText(/修改这些值只更新工作区默认值/)
    ).toBeInTheDocument();
    expect(screen.getByText(/重启进程/)).toBeInTheDocument();
  });
});
