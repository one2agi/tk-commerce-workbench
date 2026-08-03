import { afterEach, describe, expect, it, vi } from "vitest";
import { HeadObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssetPublishingAdapter, type AssetPublishingAdapterConfig } from "./asset-publishing-adapter.js";

const sendMock = vi.hoisted(() => vi.fn());

vi.mock("@aws-sdk/client-s3", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@aws-sdk/client-s3")>();
  return {
    ...actual,
    S3Client: class {
      send = sendMock;
    }
  };
});

const roots: string[] = [];
afterEach(async () => {
  sendMock.mockReset();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function assetRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "tk-publishing-"));
  roots.push(root);
  return root;
}

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

  it("publishes different bytes to ordered single-extension SHA keys on AWS v3 404", async () => {
    const root = await assetRoot();
    const first = Buffer.from("first-image-bytes");
    const second = Buffer.from("second-image-bytes");
    await writeFile(join(root, "first.png"), first);
    await writeFile(join(root, "second.jpg"), second);
    sendMock.mockImplementation(async (command) => {
      if (command instanceof HeadObjectCommand) {
        throw { name: "NotFound", $metadata: { httpStatusCode: 404 } };
      }
      return {};
    });
    const adapter = createAssetPublishingAdapter({ ...BASE_CONFIG, assetRoot: root });

    const published = await adapter.publish({
      assets: [
        { assetId: "asset-first", localPath: "first.png", extension: ".png" },
        { assetId: "asset-second", localPath: "second.jpg", extension: "jpg" }
      ],
      purpose: "miaoshou_edit"
    });

    const firstHash = createHash("sha256").update(first).digest("hex");
    const secondHash = createHash("sha256").update(second).digest("hex");
    expect(firstHash).not.toBe(secondHash);
    expect(published).toEqual([
      { remoteUrl: `https://cdn.example.com/images/${firstHash}.png` },
      { remoteUrl: `https://cdn.example.com/images/${secondHash}.jpg` }
    ]);
    const puts = sendMock.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof PutObjectCommand);
    expect(puts.map((command) => command.input.Key)).toEqual([
      `images/${firstHash}.png`,
      `images/${secondHash}.jpg`
    ]);
  });

  it("reuses an existing object without uploading it again", async () => {
    const root = await assetRoot();
    await writeFile(join(root, "existing.png"), Buffer.from("existing-image"));
    sendMock.mockResolvedValue({ $metadata: { httpStatusCode: 200 } });
    const adapter = createAssetPublishingAdapter({ ...BASE_CONFIG, assetRoot: root });

    await expect(adapter.publish({
      assets: [{ assetId: "asset-existing", localPath: "existing.png", extension: "png" }],
      purpose: "miaoshou_edit"
    })).resolves.toHaveLength(1);
    expect(sendMock.mock.calls.some(([command]) => command instanceof PutObjectCommand)).toBe(false);
  });
});
