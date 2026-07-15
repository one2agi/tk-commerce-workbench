// @vitest-environment node
import { describe, expect, it } from "vitest";
import { normalize1688OfferUrl } from "./normalize-1688-url.js";

describe("normalize1688OfferUrl", () => {
  it("extracts sourceItemId from a detail.1688.com offer URL", () => {
    const result = normalize1688OfferUrl(
      "https://detail.1688.com/offer/892408514788.html?spm=x&offerId=892408514788"
    );
    expect(result).toEqual({
      sourceItemId: "892408514788",
      canonicalUrl: "https://detail.1688.com/offer/892408514788.html"
    });
  });

  it("strips tracking parameters (spm, offerId, UTM, frags)", () => {
    const result = normalize1688OfferUrl(
      "https://detail.1688.com/offer/123456789012.html?utm_source=fb&spm=a1&offerId=999&abc=def#hash"
    );
    expect(result.sourceItemId).toBe("123456789012");
    expect(result.canonicalUrl).toBe("https://detail.1688.com/offer/123456789012.html");
  });

  it("rejects non-detail.1688.com hosts", () => {
    expect(() =>
      normalize1688OfferUrl("https://example.com/offer/892408514788.html")
    ).toThrow();
    expect(() =>
      normalize1688OfferUrl("https://detail.tmall.com/offer/892408514788.html")
    ).toThrow();
  });

  it("rejects URLs without an offer id segment", () => {
    expect(() => normalize1688OfferUrl("https://detail.1688.com/")).toThrow();
  });
});