import { describe, expect, it, vi } from "vitest";
import { createSafeImageDownloader, createSafeUrlReachability, type PinnedImageTransport } from "./safe-image-download.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

function transportResponse(overrides: Partial<Awaited<ReturnType<PinnedImageTransport>>> = {}) {
  return { status: 200, headers: { "content-type": "image/png", "content-length": String(png.byteLength) }, body: png, ...overrides };
}

describe("safe external image downloader", () => {
  it.each([
    "127.0.0.1", "10.1.2.3", "169.254.169.254", "192.168.1.2", "172.20.1.2",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1"
  ])("rejects private, link-local, metadata, and mapped address %s before transport", async (address) => {
    const transport = vi.fn(async () => transportResponse());
    const download = createSafeImageDownloader({ resolveHost: vi.fn(async () => [{ address, family: address.includes(":") ? 6 as const : 4 as const }]), transport });
    await expect(download("https://images.test/a.png")).rejects.toMatchObject({ code: "download.blocked_address" });
    expect(transport).not.toHaveBeenCalled();
  });

  it("pins the validated DNS address and validates every redirect hop", async () => {
    const resolveHost = vi.fn(async (host: string) => host === "images.test" ? [{ address: "93.184.216.34", family: 4 as const }] : [{ address: "151.101.1.69", family: 4 as const }]);
    const transport = vi.fn(async (url: URL, _pinned) => url.hostname === "images.test"
      ? transportResponse({ status: 302, headers: { location: "https://cdn.test/final.png" }, body: new Uint8Array() })
      : transportResponse());
    const download = createSafeImageDownloader({ resolveHost, transport, maxRedirects: 2 });
    await expect(download("https://images.test/a.png")).resolves.toMatchObject({ finalUrl: "https://cdn.test/final.png" });
    expect(transport.mock.calls[0]?.[1]).toEqual({ address: "93.184.216.34", family: 4 });
    expect(transport.mock.calls[1]?.[1]).toEqual({ address: "151.101.1.69", family: 4 });
  });

  it("rejects non-image content and bodies above the configured limit", async () => {
    const resolveHost = vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]);
    const textDownload = createSafeImageDownloader({ resolveHost, transport: vi.fn(async () => transportResponse({ headers: { "content-type": "text/html" } })) });
    await expect(textDownload("https://images.test/a.png")).rejects.toMatchObject({ code: "download.invalid_content_type" });
    const largeDownload = createSafeImageDownloader({ resolveHost, transport: vi.fn(async () => transportResponse({ headers: { "content-type": "image/png" }, body: new Uint8Array(11) })), maxBytes: 10 });
    await expect(largeDownload("https://images.test/a.png")).rejects.toMatchObject({ code: "download.too_large" });
  });

  it("rejects excessive redirects", async () => {
    const download = createSafeImageDownloader({
      resolveHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
      transport: vi.fn(async () => transportResponse({ status: 302, headers: { location: "/again.png" }, body: new Uint8Array() })),
      maxRedirects: 1
    });
    await expect(download("https://images.test/a.png")).rejects.toMatchObject({ code: "download.too_many_redirects" });
  });
});

describe("safe staged URL reachability", () => {
  it("uses DNS-pinned HEAD without downloading the image body", async () => {
    const transport = vi.fn(async () => ({ status: 200, headers: { "content-type": "image/png" }, bytesRead: 0 }));
    const assertReachable = createSafeUrlReachability({
      resolveHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
      transport
    });
    await expect(assertReachable("https://stage.test/a.png?signature=bearer")).resolves.toBeUndefined();
    expect(transport).toHaveBeenCalledWith(expect.any(URL), { address: "93.184.216.34", family: 4 }, "HEAD", expect.any(Number), 1);
  });

  it("falls back to a one-byte range GET when HEAD is unsupported", async () => {
    const transport = vi.fn()
      .mockResolvedValueOnce({ status: 405, headers: {}, bytesRead: 0 })
      .mockResolvedValueOnce({ status: 206, headers: { "content-type": "image/jpeg" }, bytesRead: 1 });
    const assertReachable = createSafeUrlReachability({
      resolveHost: vi.fn(async () => [{ address: "93.184.216.34", family: 4 as const }]),
      transport
    });
    await assertReachable("https://stage.test/a.jpg");
    expect(transport.mock.calls.map((call) => call[2])).toEqual(["HEAD", "RANGE"]);
    expect(transport.mock.calls[1]?.[4]).toBe(1);
  });
});
