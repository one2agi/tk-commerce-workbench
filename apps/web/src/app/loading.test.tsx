import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import Loading from "./loading";

describe("Root Loading UI", () => {
  it("renders a semantic skeleton container for route transitions", () => {
    const html = renderToStaticMarkup(<Loading />);
    expect(html).toContain('class="tk-page-skeleton"');
    expect(html).toContain('aria-busy="true"');
  });
});
