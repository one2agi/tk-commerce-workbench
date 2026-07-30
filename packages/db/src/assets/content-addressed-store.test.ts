import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentAddressedStore, createNodePinnedAssetFetch, type AssetFetch } from "./content-addressed-store.js";

const jpeg = (...payload: string[]) => Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
  ...payload.map((part) => Buffer.from(part))
]);
const png = (...payload: string[]) => Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  ...payload.map((part) => Buffer.from(part))
]);

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tk-assets-"));
  roots.push(path);
  return path;
}

describe("ContentAddressedStore", () => {
  it("node pinned fetch supports Node lookup callers that request all addresses", async () => {
    const server = createServer((request, response) => {
      response.writeHead(200, {
        "content-type": "image/jpeg",
        "x-request-host": request.headers.host ?? ""
      });
      response.end(jpeg("pinned"));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const port = (server.address() as AddressInfo).port;
      const response = await createNodePinnedAssetFetch(3_000)({
        url: `http://cdn.example:${port}/image.jpg`,
        connectAddress: "127.0.0.1",
        hostHeader: `cdn.example:${port}`
      });
      const chunks: Buffer[] = [];
      for await (const chunk of response.body ?? []) chunks.push(Buffer.from(chunk));

      expect(response.status).toBe(200);
      expect(response.headers["content-type"]).toBe("image/jpeg");
      expect(Buffer.concat(chunks)).toEqual(jpeg("pinned"));
    } finally {
      server.close();
      await once(server, "close");
    }
  });

  it("streams to a temporary file then exposes one content-addressed atomic path", async () => {
    const assetRoot = await root();
    const fetch: AssetFetch = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: (async function* () { yield jpeg("hello "); yield Buffer.from("world"); })()
    }));
    const store = new ContentAddressedStore({ assetRoot, fetch, resolveHost: async () => ["93.184.216.34"] });

    const first = await store.archive("https://cdn.example/item.jpg");
    const second = await store.archive("https://cdn.example/item.jpg");

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.path).toBe(join(assetRoot, first.sha256.slice(0, 2), `${first.sha256}.jpg`));
    expect(second.path).toBe(first.path);
    expect(await readFile(first.path)).toEqual(jpeg("hello world"));
    expect((await readdir(join(assetRoot, first.sha256.slice(0, 2)))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("archives same-machine Canvas output assets without opening general private-network downloads", async () => {
    const assetRoot = await root();
    const fetch: AssetFetch = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: (async function* () { yield png("canvas"); })()
    }));
    const resolveHost = vi.fn(async () => {
      throw new Error("public DNS validation should not run for local Canvas outputs");
    });
    const store = new ContentAddressedStore({ assetRoot, fetch, resolveHost });

    const archived = await store.archive("http://127.0.0.1:8123/assets/output/generated.png");

    expect(archived.extension).toBe("png");
    expect(fetch).toHaveBeenCalledWith(expect.objectContaining({
      connectAddress: "127.0.0.1",
      hostHeader: "127.0.0.1:8123"
    }));
    await expect(store.archive("http://127.0.0.1:8123/not-canvas/generated.png")).rejects.toThrow(/unsafe/i);
  });

  it("revalidates DNS after every redirect before the next request", async () => {
    const assetRoot = await root();
    const fetch = vi.fn<AssetFetch>()
      .mockResolvedValueOnce({ status: 302, headers: { location: "https://internal.example/secret.jpg" }, body: null })
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "image/jpeg" }, body: (async function* () { yield jpeg("secret"); })() });
    const resolveHost = vi.fn(async (host: string) => host === "internal.example" ? ["169.254.169.254"] : ["93.184.216.34"]);
    const store = new ContentAddressedStore({ assetRoot, fetch, resolveHost, maxRedirects: 3 });

    await expect(store.archive("https://cdn.example/start.jpg")).rejects.toThrow(/unsafe/i);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(resolveHost).toHaveBeenCalledTimes(2);
  });

  it("bounds redirect loops and cleans temporary files after a stream failure", async () => {
    const assetRoot = await root();
    const redirecting: AssetFetch = async () => ({ status: 302, headers: { location: "/again" }, body: null });
    const redirectStore = new ContentAddressedStore({ assetRoot, fetch: redirecting, resolveHost: async () => ["93.184.216.34"], maxRedirects: 2 });
    await expect(redirectStore.archive("https://cdn.example/start")).rejects.toThrow(/redirect/i);

    const failing: AssetFetch = async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: (async function* () { yield png("partial"); throw new Error("broken stream"); })()
    });
    const failingStore = new ContentAddressedStore({ assetRoot, fetch: failing, resolveHost: async () => ["93.184.216.34"] });
    await expect(failingStore.archive("https://cdn.example/fail.png")).rejects.toThrow("broken stream");
    expect((await readdir(assetRoot, { recursive: true })).filter((name) => String(name).includes(".tmp-"))).toEqual([]);
  });

  it("pins every request to the address validated for that redirect while preserving Host and TLS SNI", async () => {
    const assetRoot = await root();
    const fetch = vi.fn<AssetFetch>()
      .mockResolvedValueOnce({ status: 302, headers: { location: "https://images.example/final.png" }, body: null })
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "image/png" }, body: (async function* () { yield png("ok"); })() });
    const resolveHost = vi.fn(async (host: string) => host === "cdn.example" ? ["93.184.216.34"] : ["203.0.113.8"]);
    const store = new ContentAddressedStore({ assetRoot, fetch, resolveHost });

    await store.archive("https://cdn.example:8443/start");

    expect(fetch).toHaveBeenNthCalledWith(1, {
      url: "https://cdn.example:8443/start",
      connectAddress: "93.184.216.34",
      hostHeader: "cdn.example:8443",
      servername: "cdn.example"
    });
    expect(fetch).toHaveBeenNthCalledWith(2, {
      url: "https://images.example/final.png",
      connectAddress: "203.0.113.8",
      hostHeader: "images.example",
      servername: "images.example"
    });
  });

  it("rejects an oversized response before or during streaming and removes temporary files", async () => {
    const assetRoot = await root();
    const declaredTooLarge: AssetFetch = async () => ({
      status: 200,
      headers: { "content-type": "image/png", "content-length": "99" },
      body: (async function* () { yield png("never written"); })()
    });
    await expect(new ContentAddressedStore({ assetRoot, fetch: declaredTooLarge, resolveHost: async () => ["93.184.216.34"], maxBytes: 16 })
      .archive("https://cdn.example/a.png")).rejects.toThrow(/size|large/i);

    const streamedTooLarge: AssetFetch = async () => ({
      status: 200,
      headers: { "content-type": "image/png" },
      body: (async function* () { yield png("123456789"); yield Buffer.from("overflow"); })()
    });
    await expect(new ContentAddressedStore({ assetRoot, fetch: streamedTooLarge, resolveHost: async () => ["93.184.216.34"], maxBytes: 16 })
      .archive("https://cdn.example/b.png")).rejects.toThrow(/size|large/i);
    expect((await readdir(assetRoot, { recursive: true })).filter((name) => String(name).includes(".tmp-"))).toEqual([]);
  });

  it.each([
    ["image/webp", Buffer.from("RIFF....WEBP")],
    ["image/png", Buffer.from("not a png")],
    ["image/jpeg", png("mismatch")],
    [undefined, jpeg("missing type")]
  ])("rejects unsupported or spoofed image content (%s)", async (contentType, bytes) => {
    const assetRoot = await root();
    const fetch: AssetFetch = async () => ({
      status: 200,
      headers: contentType ? { "content-type": contentType } : {},
      body: (async function* () { yield bytes; })()
    });
    const store = new ContentAddressedStore({ assetRoot, fetch, resolveHost: async () => ["93.184.216.34"] });

    await expect(store.archive("https://cdn.example/image")).rejects.toThrow(/PNG|JPEG|content.type|image/i);
    expect((await readdir(assetRoot, { recursive: true })).filter((name) => String(name).includes(".tmp-"))).toEqual([]);
  });
});
