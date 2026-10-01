import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NavigationProgressBar } from "./progress-bar";

describe("NavigationProgressBar", () => {
  it("renders the navigation progress container with accessibility attributes", () => {
    const html = renderToStaticMarkup(<NavigationProgressBar />);
    expect(html).toContain('class="tk-progress-bar"');
    expect(html).toContain('aria-hidden="true"');
  });
});
