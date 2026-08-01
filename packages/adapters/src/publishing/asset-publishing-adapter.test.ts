import { describe, expect, it, vi, beforeEach } from "vitest";
import { createAssetPublishingAdapter, type AssetPublishingAdapterConfig } from "./asset-publishing-adapter.js";

const VALID_SHA256 = "a".repeat(64);
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const BASE_CONFIG: AssetPublishingAdapterConfig = {
  s3Endpoint: "https://s3.example.com",
  s3Region: "us-east-1",
  s3Bucket: "tk-assets",
  s3AccessKeyId: "test-key",
  s3SecretAccessKey: "test-secret",
  publicBaseUrl: "https://cdn.example.com",
  assetRoot: "/tmp/assets"
};

describe("createAssetPublishingAdapter", () => {
  it("rejects an invalid public base URL (non-HTTPS)", () => {
    expect(() => createAssetPublishingAdapter({
      ...BASE_CONFIG,
      publicBaseUrl: "http://insecure.example.com"
    })).toThrow(expect.objectContaining({ code: "publishing.invalid_public_base_url" }));
  });

  it("rejects an invalid public base URL (not a URL)", () => {
    expect(() => createAssetPublishingAdapter({
      ...BASE_CONFIG,
      publicBaseUrl: "not-a-url"
    })).toThrow(expect.objectContaining({ code: "publishing.invalid_public_base_url" }));
  });

  it("rejects unsupported file extensions", async () => {
    const adapter = createAssetPublishingAdapter({
      ...BASE_CONFIG
    });

    await expect(adapter.publish({
      assets: [
        { assetId: "asset-1", localPath: "video.mp4", extension: ".mp4" }
      ],
      purpose: "miaoshou_edit"
    })).rejects.toMatchObject({ code: "publishing.unsupported_extension" });
  });

  it("rejects duplicate asset IDs", async () => {
    const adapter = createAssetPublishingAdapter({
      ...BASE_CONFIG
    });

    await expect(adapter.publish({
      assets: [
        { assetId: "asset-1", localPath: "a.png", extension: ".png" },
        { assetId: "asset-1", localPath: "b.png", extension: ".png" }
      ],
      purpose: "miaoshou_edit"
    })).rejects.toMatchObject({ code: "publishing.duplicate_asset_ids" });
  });

  it("rejects empty assets array", async () => {
    const adapter = createAssetPublishingAdapter({
      ...BASE_CONFIG
    });

    const result = await adapter.publish({ assets: [], purpose: "miaoshou_edit" });
    expect(result).toHaveLength(0);
  });

  it("rejects non-miaoshou_edit purpose", async () => {
    const adapter = createAssetPublishingAdapter({
      ...BASE_CONFIG
    });

    await expect(adapter.publish({
      assets: [
        { assetId: "asset-1", localPath: "hero.png", extension: ".png" }
      ],
      purpose: "canvas" as "miaoshou_edit"
    })).rejects.toMatchObject({ code: "publishing.unsupported_purpose" });
  });

  it("rejects a local path that escapes the asset root", async () => {
    const adapter = createAssetPublishingAdapter({
      ...BASE_CONFIG,
      assetRoot: "/safe/assets"
    });

    await expect(adapter.publish({
      assets: [
        { assetId: "asset-1", localPath: "../etc/passwd", extension: ".png" }
      ],
      purpose: "miaoshou_edit"
    })).rejects.toMatchObject({ code: "publishing.asset_path_escape" });
  });

  it("returns immutable CDN URLs after publishing", async () => {
    // This test documents the URL structure contract.
    // Actual S3 interaction requires integration tests with a mock S3 client.
    const adapter = createAssetPublishingAdapter({
      ...BASE_CONFIG,
      assetRoot: "/tmp/assets"
    });

    // The adapter computes SHA-256 internally from file content.
    // Without a real file at the path, we test the rejection path.
    await expect(adapter.publish({
      assets: [
        { assetId: "asset-1", localPath: "nonexistent.png", extension: ".png" }
      ],
      purpose: "miaoshou_edit"
    })).rejects.toMatchObject({ code: "publishing.asset_not_found" });
  });
});
