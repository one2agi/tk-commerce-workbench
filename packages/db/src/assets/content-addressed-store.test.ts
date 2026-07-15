import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ContentAddressedStore, type AssetFetch } from "./content-addressed-store.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "tk-assets-"));
  roots.push(path);
  return path;
}

describe("ContentAddressedStore", () => {
  it("streams to a temporary file then exposes one content-addressed atomic path", async () => {
    const assetRoot = await root();
    const fetch: AssetFetch = vi.fn(async () => ({
      status: 200,
      headers: { "content-type": "image/jpeg" },
      body: (async function* () { yield Buffer.from("hello "); yield Buffer.from("world"); })()
    }));
    const store = new ContentAddressedStore({ assetRoot, fetch, resolveHost: async () => ["93.184.216.34"] });

    const first = await store.archive("https://cdn.example/item.jpg");
    const second = await store.archive("https://cdn.example/item.jpg");

    expect(first.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first.path).toBe(join(assetRoot, first.sha256.slice(0, 2), `${first.sha256}.jpg`));
    expect(second.path).toBe(first.path);
    expect(await readFile(first.path, "utf8")).toBe("hello world");
    expect((await readdir(join(assetRoot, first.sha256.slice(0, 2)))).filter((name) => name.includes(".tmp-"))).toEqual([]);
  });

  it("revalidates DNS after every redirect before the next request", async () => {
    const assetRoot = await root();
    const fetch = vi.fn<AssetFetch>()
      .mockResolvedValueOnce({ status: 302, headers: { location: "https://internal.example/secret.jpg" }, body: null })
      .mockResolvedValueOnce({ status: 200, headers: { "content-type": "image/jpeg" }, body: (async function* () { yield Buffer.from("secret"); })() });
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
      body: (async function* () { yield Buffer.from("partial"); throw new Error("broken stream"); })()
    });
    const failingStore = new ContentAddressedStore({ assetRoot, fetch: failing, resolveHost: async () => ["93.184.216.34"] });
    await expect(failingStore.archive("https://cdn.example/fail.png")).rejects.toThrow("broken stream");
    expect((await readdir(assetRoot, { recursive: true })).filter((name) => String(name).includes(".tmp-"))).toEqual([]);
  });
});
