import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { Sidebar } from "./sidebar";

describe("Sidebar", () => {
  it("links to the image template workspace", () => {
    const html = renderToStaticMarkup(<Sidebar />);

    expect(html).toContain('href="/templates"');
    expect(html).toContain("生图模板");
  });
});
