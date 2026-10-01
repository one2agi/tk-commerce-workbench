import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import ProcessingRulesPage from "./page";
import * as pageExports from "./page";

describe("ProcessingRulesPage", () => {
  it("renders rules content cleanly", () => {
    const html = renderToStaticMarkup(<ProcessingRulesPage />);
    expect(html).toContain("处理规则");
    expect(html).toContain("标题规则");
  });

  it("is not forced dynamic so client can cache and switch instantly", () => {
    expect((pageExports as Record<string, unknown>).dynamic).toBeUndefined();
  });
});
