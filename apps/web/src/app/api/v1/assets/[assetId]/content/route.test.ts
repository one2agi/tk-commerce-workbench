import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createGetHandler } from "./route";

const temporaryRoots: string[] = [];

async function assetFixture() {
  const root = await mkdtemp(join(tmpdir(), "tk-asset-route-"));
  temporaryRoots.push(root);
  const path = join(root, "asset.png");
  await writeFile(path, new Uint8Array([137, 80, 78, 71]));
  return { root, path };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("GET /api/v1/assets/:assetId/content", () => {
  it("keeps the original asset response unchanged when no variant is requested", async () => {
    const fixture = await assetFixture();
    const response = await createGetHandler({
      assets: { localPath: vi.fn().mockResolvedValue(fixture.path) },
      assetRoot: fixture.root
    })(new Request("http://127.0.0.1/api/v1/assets/asset_1/content"), {
      params: Promise.resolve({ assetId: "asset_1" })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([137, 80, 78, 71]));
  });

  it("returns a generated WebP thumbnail for variant=thumbnail", async () => {
    const fixture = await assetFixture();
    const thumbnailer = vi.fn().mockResolvedValue(new Uint8Array([82, 73, 70, 70]));
    const response = await createGetHandler({
      assets: { localPath: vi.fn().mockResolvedValue(fixture.path) },
      assetRoot: fixture.root,
      thumbnailer
    })(new Request("http://127.0.0.1/api/v1/assets/asset_1/content?variant=thumbnail"), {
      params: Promise.resolve({ assetId: "asset_1" })
    });

    expect(response.status).toBe(200);
    expect(thumbnailer).toHaveBeenCalledWith(fixture.path);
    expect(response.headers.get("content-type")).toBe("image/webp");
    expect(response.headers.get("cache-control")).toBe("private, max-age=86400");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(new Uint8Array([82, 73, 70, 70]));
  });

  it("rejects unknown variants without reading or transforming the asset", async () => {
    const fixture = await assetFixture();
    const read = vi.fn();
    const thumbnailer = vi.fn();
    const response = await createGetHandler({
      assets: { localPath: vi.fn().mockResolvedValue(fixture.path) },
      assetRoot: fixture.root,
      read,
      thumbnailer
    })(new Request("http://127.0.0.1/api/v1/assets/asset_1/content?variant=large"), {
      params: Promise.resolve({ assetId: "asset_1" })
    });

    expect(response.status).toBe(400);
    expect(read).not.toHaveBeenCalled();
    expect(thumbnailer).not.toHaveBeenCalled();
    expect(response.headers.get("cache-control")).toBeNull();
  });
});
