import { describe, expect, it } from "vitest";

import {
  parseAllowedSourceImageUrl,
  sourceImageProxyPath
} from "./source-image-url";

describe("source image URL boundary", () => {
  it.each([
    "https://cbu01.alicdn.com/img/ibank/a.jpg",
    "https://img.alicdn.com/imgextra/a.webp",
    "http://img.1688.com/a.png"
  ])("accepts configured source image hosts: %s", (value) => {
    expect(parseAllowedSourceImageUrl(value)?.href).toBe(value);
  });

  it.each([
    "https://alicdn.com.evil.test/a.jpg",
    "https://evilalicdn.com/a.jpg",
    "file:///etc/passwd",
    "http://127.0.0.1/private.png",
    "not-a-url"
  ])("rejects unsafe source image URLs: %s", (value) => {
    expect(parseAllowedSourceImageUrl(value)).toBeNull();
    expect(sourceImageProxyPath(value)).toBeNull();
  });

  it("encodes an allowed URL into the same-origin source image route", () => {
    const source = "https://cbu01.alicdn.com/img/a.jpg?x=1&y=2";
    expect(sourceImageProxyPath(source)).toBe(
      `/api/v1/source-images?url=${encodeURIComponent(source)}`
    );
  });
});
