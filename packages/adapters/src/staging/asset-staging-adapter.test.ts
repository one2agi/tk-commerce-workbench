import { describe, expect, it } from "vitest";
import { createAssetStagingAdapter } from "./asset-staging-adapter.js";

describe("asset staging adapter", () => {
  it("produces ordered expiring URLs without changing asset selection", async () => {
    const adapter = createAssetStagingAdapter({ publicBaseUrl: "https://assets.test/staged", ttlMs: 3_600_000, nowMs: () => Date.parse("2026-07-16T00:00:00.000Z") });
    const result = await adapter.stage({ localAssetIds: ["asset 2", "asset/1"], purpose: "canvas" });
    expect(result.map((item) => item.remoteUrl)).toEqual([
      "https://assets.test/staged/asset%202?purpose=canvas",
      "https://assets.test/staged/asset%2F1?purpose=canvas"
    ]);
    expect(result[0]?.expiresAt).toBe("2026-07-16T01:00:00.000Z");
  });

  it("rejects empty or duplicate local asset ids instead of making a business selection", async () => {
    const adapter = createAssetStagingAdapter({ publicBaseUrl: "https://assets.test/staged" });
    await expect(adapter.stage({ localAssetIds: ["same", "same"], purpose: "canvas" })).rejects.toMatchObject({ kind: "needs_input", code: "staging.invalid_asset_ids" });
  });
});
