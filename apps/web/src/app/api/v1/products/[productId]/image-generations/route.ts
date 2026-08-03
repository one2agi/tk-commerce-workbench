import type { ImageGenerationService } from "../../../../../../server/services/image-generation-service";
import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";

type Context = { params: Promise<{ productId: string }> };

export function createStartHandler(deps: { service: ImageGenerationService }) {
  return async function post(request: Request, context: Context): Promise<Response> {
    const loopbackRejection = rejectNonLoopback(request);
    if (loopbackRejection) return loopbackRejection;

    const unsafe = rejectUnsafeBrowserMutation(request);
    if (unsafe) return unsafe;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const { revisionId, categoryKey, selectedAssetIds, outputCount, runIntentId } = body as Record<string, unknown>;

    if (typeof revisionId !== "string" || !revisionId.trim()) {
      return Response.json({ error: "invalid_request", detail: "revisionId required" }, { status: 400 });
    }
    if (typeof categoryKey !== "string" || !categoryKey.trim()) {
      return Response.json({ error: "invalid_request", detail: "categoryKey required" }, { status: 400 });
    }
    if (!Array.isArray(selectedAssetIds) || selectedAssetIds.length < 1 || selectedAssetIds.length > 6) {
      return Response.json({ error: "invalid_request", detail: "selectedAssetIds must be 1-6 items" }, { status: 400 });
    }
    if (typeof outputCount !== "number" || outputCount < 1 || outputCount > 8) {
      return Response.json({ error: "invalid_request", detail: "outputCount must be 1-8" }, { status: 400 });
    }
    if (runIntentId !== undefined && (typeof runIntentId !== "string" || !runIntentId.trim() || runIntentId.length > 128)) {
      return Response.json({ error: "invalid_request", detail: "runIntentId must be a non-empty string up to 128 characters" }, { status: 400 });
    }

    try {
      const { productId } = await context.params;
      const result = await deps.service.start({
        productId,
        revisionId: revisionId as string,
        categoryKey: categoryKey as string,
        selectedAssetIds: selectedAssetIds as string[],
        outputCount: outputCount as number,
        ...(typeof runIntentId === "string" ? { runIntentId } : {})
      });
      return Response.json(result, { status: 201 });
    } catch (err: unknown) {
      if (err && typeof err === "object" && "code" in err) {
        const code = (err as { code: string }).code;
        if (
          [
            "input_count_out_of_range",
            "output_count_out_of_range",
            "duplicate_assets",
            "template_not_found",
            "no_active_template_version",
            "idempotency_key_conflict"
          ].includes(code)
        ) {
          return Response.json({ error: code }, { status: 409 });
        }
      }
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  const svcs = await getServerServices();
  return createStartHandler({ service: svcs.imageGeneration })(request, context);
}
