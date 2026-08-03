import type { ImageGenerationService } from "../../../../../../../../../server/services/image-generation-service";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../../../../server/auth/loopback";

type Context = { params: Promise<{ productId: string; batchId: string; slotId: string }> };

export function createSlotActionHandler(deps: { service: ImageGenerationService }) {
  return async function patch(request: Request, context: Context): Promise<Response> {
    const loopbackRejection = rejectNonLoopback(request);
    if (loopbackRejection) return loopbackRejection;

    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const { action, batchId, slotId } = body as Record<string, unknown>;

    if (action !== "retry" && action !== "exclude") {
      return Response.json({ error: "invalid_request", detail: "action must be 'retry' or 'exclude'" }, { status: 400 });
    }
    if (typeof batchId !== "string" || !batchId.trim()) {
      return Response.json({ error: "invalid_request", detail: "batchId required" }, { status: 400 });
    }
    if (typeof slotId !== "string" || !slotId.trim()) {
      return Response.json({ error: "invalid_request", detail: "slotId required" }, { status: 400 });
    }

    try {
      const { productId } = await context.params;
      if (action === "retry") {
        const result = await deps.service.retrySlot({ productId, batchId: batchId as string, slotId: slotId as string });
        return Response.json(result);
      } else {
        const result = await deps.service.excludeSlot({ productId, batchId: batchId as string, slotId: slotId as string });
        return Response.json(result);
      }
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: string }).code;
        if (["batch_not_found", "slot_not_found", "slot_not_retryable", "slot_not_excludable"].includes(code)) {
          return Response.json({ error: code }, { status: 409 });
        }
      }
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

export async function PATCH(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../../../../../server/composition");
  const svcs = await getServerServices();
  return createSlotActionHandler({ service: svcs.imageGeneration })(request, context);
}
