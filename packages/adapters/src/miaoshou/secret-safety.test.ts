import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  createMiaoshouSourceAdapter,
  type MiaoshouHttp,
  type MiaoshouConfig
} from "./source-adapter.js";
import { idempotencyKey } from "@tk/contracts";

const FIXTURES_DIR = fileURLToPath(
  new URL("../../../../tests/fixtures/external/miaoshou", import.meta.url)
);

const SENTINELS = {
  miaoshou: "TEST_MIAOSHOU_SECRET_DO_NOT_LOG",
  extension: "TEST_EXTENSION_TOKEN_DO_NOT_LOG"
};

function createFakeHttp(responses: Record<string, () => unknown>): MiaoshouHttp & { calls: Array<{ path: string; body: unknown }> } {
  const calls: Array<{ path: string; body: unknown }> = [];
  return {
    calls,
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ path, body });
      const r = responses[path];
      if (!r) throw new Error(`unexpected POST ${path}`);
      return r() as T;
    }
  };
}

describe("secret safety", () => {
  it("never logs Miaoshou app secret in success or error paths", async () => {
    const captured: string[] = [];
    const origLog = console.log;
    const origWarn = console.warn;
    const origError = console.error;
    console.log = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    console.warn = (...args: unknown[]) => captured.push(args.map(String).join(" "));
    console.error = (...args: unknown[]) => captured.push(args.map(String).join(" "));

    try {
      const config: MiaoshouConfig = {
        baseUrl: "https://api.miaoshou.test",
        appKey: "test-key",
        appSecret: SENTINELS.miaoshou
      };
      const detailFixture = JSON.parse(readFileSync(`${FIXTURES_DIR}/detail-3799770548.json`, "utf8"));
      const http = createFakeHttp({
        "/open/v1/product/common_collect_box/common_collect_box/fetch_item": () => ({
          code: 0,
          data: { status: "success", detailId: "3801638367", sourceItemId: "892408514788" }
        }),
        "/open/v1/product/common_collect_box/common_collect_box/get_common_collect_box_detail": () => detailFixture
      });
      const adapter = createMiaoshouSourceAdapter({ http, config });
      const result = await adapter.fetchItem({
        sourceUrl: "https://detail.1688.com/offer/892408514788.html",
        idempotencyKey: idempotencyKey("idem_secret_01")
      });

      // Serialize ExternalFailure-shaped errors.
      const fail = adapter.describeFailure(result.detail);
      captured.push(JSON.stringify(fail));

      // Error path: missing url triggers ExternalFailure.
      const http2 = createFakeHttp({});
      const adapter2 = createMiaoshouSourceAdapter({ http: http2, config });
      try {
        await adapter2.fetchItem({
          sourceUrl: "not-a-url",
          idempotencyKey: idempotencyKey("idem_secret_02")
        });
      } catch (e) {
        captured.push((e as Error).message);
      }

      // Serialize all fixture files into the captured buffer too.
      const files = readdirSync(FIXTURES_DIR).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        const content = readFileSync(`${FIXTURES_DIR}/${f}`, "utf8");
        captured.push(content);
      }
    } finally {
      console.log = origLog;
      console.warn = origWarn;
      console.error = origError;
    }

    const all = captured.join("\n");
    expect(all.includes(SENTINELS.miaoshou)).toBe(false);
    expect(all.includes(SENTINELS.extension)).toBe(false);
  });
});