import { describe, expect, it, vi } from "vitest";
import { assertSafeRemoteUrl, isUnsafeAddress, resolveSafeRemoteUrl } from "./validate-remote-url.js";

describe("assertSafeRemoteUrl", () => {
  it.each([
    "http://127.0.0.1/a.jpg",
    "http://10.1.2.3/a.jpg",
    "http://172.20.0.1/a.jpg",
    "http://192.168.1.1/a.jpg",
    "http://169.254.169.254/latest/meta-data",
    "http://[::1]/a.jpg",
    "http://metadata.google.internal/computeMetadata/v1",
    "ftp://cdn.example/a.jpg"
  ])("rejects unsafe URL %s before a request", async (url) => {
    const resolve = vi.fn(async () => ["93.184.216.34"]);
    await expect(assertSafeRemoteUrl(url, resolve)).rejects.toThrow(/unsafe|protocol|metadata/i);
  });

  it("rejects a public hostname when DNS resolves to a private address", async () => {
    const resolve = vi.fn(async () => ["10.0.0.8"]);
    await expect(assertSafeRemoteUrl("https://cdn.example/a.jpg", resolve)).rejects.toThrow(/unsafe/i);
    expect(resolve).toHaveBeenCalledOnce();
  });

  it("accepts only when every resolved address is public", async () => {
    await expect(
      assertSafeRemoteUrl("https://cdn.example/a.jpg", async () => ["93.184.216.34", "2606:2800:220:1:248:1893:25c8:1946"])
    ).resolves.toMatchObject({ hostname: "cdn.example" });
  });

  it.each([
    "::ffff:127.0.0.1",
    "::ffff:7f00:1",
    "::ffff:a9fe:a9fe",
    "64:ff9b::7f00:1",
    "64:ff9b:1::1",
    "2001::1",
    "2002:7f00:1::",
    "3fff::1",
    "ff02::1",
    "100::1",
    "2001:db8::1",
    "fec0::1"
  ])("rejects mapped, multicast, and special-purpose IPv6 address %s", (address) => {
    expect(isUnsafeAddress(address)).toBe(true);
  });

  it("returns the exact public addresses that were validated for connection pinning", async () => {
    await expect(
      resolveSafeRemoteUrl("https://cdn.example:8443/a.jpg", async () => ["93.184.216.34"])
    ).resolves.toMatchObject({
      url: expect.objectContaining({ hostname: "cdn.example" }),
      addresses: ["93.184.216.34"]
    });
  });
});
