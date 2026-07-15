// @vitest-environment node
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CARD_SELECTORS } from "./scan-store.js";

describe("1688 frozen store DOM fixture", () => {
  it("extracts only real product cards using the local collector selectors", () => {
    const html = readFileSync(fileURLToPath(new URL("./__fixtures__/1688-store-card.html", import.meta.url)), "utf8");
    expect(CARD_SELECTORS).toContain(".search-offer-wrapper");
    expect(CARD_SELECTORS).toContain("[data-renderkey][class*='search-offer']");
    const ids = Array.from(html.matchAll(/(?:offer\/|offerIds=)(\d+)/g), (match) => match[1]).sort();
    expect(ids).toEqual(["777777777777", "892408514788"]);
    expect(html).toContain('data-renderkey="unrelated-widget"');
  });
});
