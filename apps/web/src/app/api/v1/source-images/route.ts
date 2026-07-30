import { rejectNonLoopback } from "../../../../server/auth/loopback";
import { parseAllowedSourceImageUrl } from "../../../../server/source-image-url";

export const MAX_SOURCE_IMAGE_BYTES = 15 * 1024 * 1024;

export function createGetHandler(dependencies: { fetcher?: typeof fetch }) {
  return async function get(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request);
    if (rejected) return rejected;

    const raw = new URL(request.url).searchParams.get("url") ?? "";
    const sourceUrl = parseAllowedSourceImageUrl(raw);
    if (!sourceUrl) {
      return Response.json({ error: "invalid_source_image_url" }, { status: 400 });
    }

    try {
      const upstream = await (dependencies.fetcher ?? fetch)(sourceUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
        headers: {
          accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.1",
          referer: "https://detail.1688.com/"
        }
      });
      if (upstream.status >= 300 && upstream.status < 400) {
        return Response.json({ error: "source_image_redirect_rejected" }, { status: 502 });
      }
      if (!upstream.ok) {
        return Response.json({ error: "source_image_unavailable" }, { status: 502 });
      }

      const contentType = upstream.headers.get("content-type")?.split(";")[0]?.trim() ?? "";
      if (!contentType.startsWith("image/")) {
        return Response.json({ error: "unsupported_source_image_type" }, { status: 415 });
      }

      const declaredSize = Number(upstream.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredSize) && declaredSize > MAX_SOURCE_IMAGE_BYTES) {
        return Response.json({ error: "source_image_too_large" }, { status: 413 });
      }

      const body = new Uint8Array(await upstream.arrayBuffer());
      if (body.byteLength > MAX_SOURCE_IMAGE_BYTES) {
        return Response.json({ error: "source_image_too_large" }, { status: 413 });
      }

      return new Response(body as BodyInit, {
        headers: {
          "content-type": contentType,
          "cache-control": "private, max-age=300",
          "x-content-type-options": "nosniff"
        }
      });
    } catch {
      return Response.json({ error: "source_image_unavailable" }, { status: 502 });
    }
  };
}

export const GET = createGetHandler({});
