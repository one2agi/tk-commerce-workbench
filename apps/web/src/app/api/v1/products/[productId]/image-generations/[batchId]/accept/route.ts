import type { ImageGenerationService } from "../../../../../../../../server/services/image-generation-service";
import { rejectNonLoopback } from "../../../../../../../../server/auth/loopback";

type Context = { params: Promise<{ productId: string; batchId: string }> };

export function createAcceptHandler(deps: { service: ImageGenerationService }) {
  return async function post(request: Request, context: Context): Promise<Response> {
    const loopbackRejection = rejectNonLoopback(request);
    if (loopbackRejection) return loopbackRejection;

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const origin = request.headers.get("origin");
    if (contentType !== "application/json" || !origin) {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }

    try {
      const reqUrl = new URL(request.url);
      const oriUrl = new URL(origin);
      if (
        reqUrl.protocol !== oriUrl.protocol ||
        reqUrl.port !== oriUrl.port ||
        reqUrl.hostname !== oriUrl.hostname
      ) {
        return Response.json({ error: "same_origin_json_required" }, { status: 403 });
      }
    } catch {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const { orderedSlotIds } = body as Record<string, unknown>;

    if (!Array.isArray(orderedSlotIds)) {
      return Response.json({ error: "invalid_request", detail: "orderedSlotIds must be an array" }, { status: 400 });
    }

    try {
      const { productId, batchId } = await context.params;
      const result = await deps.service.acceptPartial({
        productId,
        batchId,
        orderedSlotIds: orderedSlotIds as string[]
      });
      return Response.json(result);
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: string }).code;
        if ([
          "batch_not_found",
          "no_successful_slots",
          "duplicate_slot_ids",
          "slot_not_found",
          "slot_not_successful"
        ].includes(code)) {
          return Response.json({ error: code }, { status: 409 });
        }
      }
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../../../../server/composition");
  const svcs = await getServerServices();
  return createAcceptHandler({ service: svcs.imageGeneration })(request, context);
}
