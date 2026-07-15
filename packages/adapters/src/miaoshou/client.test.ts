import { describe, expect, it } from "vitest";
import { createMiaoshouClient, MIAOSHOU_DEFAULT_BASE_URL } from "./client.js";

describe("Miaoshou OpenAPI client", () => {
  it("uses the verified ERP OpenAPI base URL", () => {
    expect(MIAOSHOU_DEFAULT_BASE_URL).toBe("https://openapi-erp.91miaoshou.com");
  });

  it("matches the documented HmacSHA256 signing golden vector", () => {
    const client = createMiaoshouClient({
      baseUrl: MIAOSHOU_DEFAULT_BASE_URL,
      appKey: "test-key",
      appSecret: "test-secret"
    });
    const path = "/open/v1/product/common_collect_box/common_collect_box/fetch_item";
    const body = {
      collectLinks: ["https://detail.1688.com/offer/892408514788.html"]
    };

    expect(client.sign({ path, body }, 1_721_000_000)).toEqual({
      "content-type": "application/json",
      "x-app-key": "test-key",
      "x-timestamp": "1721000000",
      "x-sign": "031a56c50b704dce0e91d8fa7b91048f142c555cf0c614574a9a205597bd4e05"
    });
  });
});
