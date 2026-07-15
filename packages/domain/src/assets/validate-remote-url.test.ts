import { describe, expect, it, vi } from "vitest";
import { assertSafeRemoteUrl } from "./validate-remote-url.js";

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
});
