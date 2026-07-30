import { describe, expect, it, vi } from "vitest";

import { createGetHandler, MAX_SOURCE_IMAGE_BYTES } from "./route";

const requestFor = (url: string) =>
  new Request(`http://127.0.0.1/api/v1/source-images?url=${encodeURIComponent(url)}`);

describe("GET /api/v1/source-images", () => {
  it("returns an allowed image with private caching and nosniff", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      new Uint8Array([137, 80, 78, 71]),
      {
        status: 200,
        headers: {
          "content-type": "image/png",
          "content-length": "4"
        }
      }
    ));

    const response = await createGetHandler({ fetcher })(
      requestFor("https://cbu01.alicdn.com/img/a.png")
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=300");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71])
    );
  });

  it.each([
    ["unsafe host", "https://example.com/a.jpg", 400],
    ["loopback target", "http://127.0.0.1/a.jpg", 400]
  ])("rejects %s", async (_name, url, status) => {
    const response = await createGetHandler({ fetcher: vi.fn() })(requestFor(url));
    expect(response.status).toBe(status);
  });

  it("rejects upstream redirects", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 302,
        headers: { location: "http://127.0.0.1/a" }
      })
    );

    const response = await createGetHandler({ fetcher })(
      requestFor("https://cbu01.alicdn.com/redirect")
    );

    expect(response.status).toBe(502);
  });

  it("rejects non-image responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response("html", { headers: { "content-type": "text/html" } })
    );

    const response = await createGetHandler({ fetcher })(
      requestFor("https://cbu01.alicdn.com/a")
    );

    expect(response.status).toBe(415);
  });

  it("rejects responses whose declared size exceeds the limit", async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(
      new Uint8Array(1),
      {
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(MAX_SOURCE_IMAGE_BYTES + 1)
        }
      }
    ));

    const response = await createGetHandler({ fetcher })(
      requestFor("https://cbu01.alicdn.com/a.jpg")
    );

    expect(response.status).toBe(413);
  });
});
