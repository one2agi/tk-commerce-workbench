import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createMiaoshouClient, createMiaoshouHttp, MIAOSHOU_DEFAULT_BASE_URL } from "./client.js";

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

  it("signs the exact JSON bytes sent and injects optional host auth", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ result: "success", code: "0", data: {} })));
    const config = {
      baseUrl: MIAOSHOU_DEFAULT_BASE_URL,
      appKey: "test-key",
      appSecret: "test-secret",
      accountId: "account-1",
      authorization: "Bearer host-token",
      cookie: "session=host-cookie"
    };
    const http = createMiaoshouHttp(config, fetchImpl as unknown as typeof fetch, () => 1_721_000_000);
    const path = "/open/v1/example";
    const body = { title: "中文", nested: { value: 1 } };
    await http.post(path, body);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sentBody = String(init.body);
    const headers = init.headers as Record<string, string>;
    const canonical = `test-secret${path}1721000000test-key${sentBody}test-secret`;
    expect(sentBody).toBe(JSON.stringify(body));
    expect(headers["x-sign"]).toBe(createHmac("sha256", "test-secret").update(canonical).digest("hex"));
    expect(headers["x-account-id"]).toBe("account-1");
    expect(headers.authorization).toBe("Bearer host-token");
    expect(headers.cookie).toBe("session=host-cookie");
  });

  it("keeps every credential out of transport errors", async () => {
    const http = createMiaoshouHttp({
      baseUrl: MIAOSHOU_DEFAULT_BASE_URL,
      appKey: "TEST_KEY_DO_NOT_LOG",
      appSecret: "TEST_SECRET_DO_NOT_LOG",
      authorization: "TEST_AUTH_DO_NOT_LOG",
      cookie: "TEST_COOKIE_DO_NOT_LOG"
    }, vi.fn(async () => { throw new Error("socket closed"); }) as unknown as typeof fetch);
    let serialized = "";
    try {
      await http.post("/open/v1/example", { value: 1 });
    } catch (error) {
      serialized = JSON.stringify(error);
    }
    expect(serialized).toContain("miaoshou.network");
    expect(serialized).not.toMatch(/TEST_(?:KEY|SECRET|AUTH|COOKIE)_DO_NOT_LOG/);
  });
});
