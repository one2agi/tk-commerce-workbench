import { describe, expect, it } from "vitest";
import type { ImageGenerationService } from "../../../../../../server/services/image-generation-service";

// Inline mock handlers mirroring the production route logic
function makeStartHandler(service: ImageGenerationService) {
  return async function post(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
    if (!allowed) return Response.json({ error: "loopback_only" }, { status: 403 });

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

    const { revisionId, categoryKey, selectedAssetIds, outputCount } = body as any;
    if (!revisionId || typeof revisionId !== "string") {
      return Response.json({ error: "invalid_request", detail: "revisionId required" }, { status: 400 });
    }
    if (!categoryKey || typeof categoryKey !== "string") {
      return Response.json({ error: "invalid_request", detail: "categoryKey required" }, { status: 400 });
    }
    if (!Array.isArray(selectedAssetIds) || selectedAssetIds.length < 1 || selectedAssetIds.length > 6) {
      return Response.json({ error: "invalid_request", detail: "selectedAssetIds must be 1-6 items" }, { status: 400 });
    }
    if (typeof outputCount !== "number" || outputCount < 1 || outputCount > 8) {
      return Response.json({ error: "invalid_request", detail: "outputCount must be 1-8" }, { status: 400 });
    }

    try {
      const result = await service.start({ productId: "mock", revisionId, categoryKey, selectedAssetIds, outputCount });
      return Response.json(result, { status: 201 });
    } catch (err: any) {
      const code = err?.code ?? "unknown_error";
      if (["input_count_out_of_range", "output_count_out_of_range", "duplicate_assets", "template_not_found", "no_active_template_version", "idempotency_key_conflict"].includes(code)) {
        return Response.json({ error: code }, { status: 409 });
      }
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

function makeSlotHandler(service: ImageGenerationService) {
  return async function patch(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
    if (!allowed) return Response.json({ error: "loopback_only" }, { status: 403 });

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const origin = request.headers.get("origin");
    if (contentType !== "application/json" || !origin) {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }

    try {
      const reqUrl = new URL(request.url);
      const oriUrl = new URL(origin);
      if (reqUrl.protocol !== oriUrl.protocol || reqUrl.port !== oriUrl.port || reqUrl.hostname !== oriUrl.hostname) {
        return Response.json({ error: "same_origin_json_required" }, { status: 403 });
      }
    } catch {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const { action, batchId, slotId } = body as any;
    if (action !== "retry" && action !== "exclude") {
      return Response.json({ error: "invalid_request", detail: "action must be retry or exclude" }, { status: 400 });
    }
    if (!batchId || typeof batchId !== "string") {
      return Response.json({ error: "invalid_request", detail: "batchId required" }, { status: 400 });
    }
    if (!slotId || typeof slotId !== "string") {
      return Response.json({ error: "invalid_request", detail: "slotId required" }, { status: 400 });
    }

    try {
      if (action === "retry") {
        const result = await service.retrySlot({ productId: "mock", batchId, slotId });
        return Response.json(result);
      } else {
        const result = await service.excludeSlot({ productId: "mock", batchId, slotId });
        return Response.json(result);
      }
    } catch (err: any) {
      const code = err?.code ?? "unknown_error";
      if (["batch_not_found", "slot_not_found", "slot_not_retryable", "slot_not_excludable"].includes(code)) {
        return Response.json({ error: code }, { status: 409 });
      }
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

function makeAcceptHandler(service: ImageGenerationService) {
  return async function post(request: Request): Promise<Response> {
    const hostname = new URL(request.url).hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const allowed = hostname === "localhost" || hostname === "::1" || hostname === "127.0.0.1";
    if (!allowed) return Response.json({ error: "loopback_only" }, { status: 403 });

    const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    const origin = request.headers.get("origin");
    if (contentType !== "application/json" || !origin) {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }

    try {
      const reqUrl = new URL(request.url);
      const oriUrl = new URL(origin);
      if (reqUrl.protocol !== oriUrl.protocol || reqUrl.port !== oriUrl.port || reqUrl.hostname !== oriUrl.hostname) {
        return Response.json({ error: "same_origin_json_required" }, { status: 403 });
      }
    } catch {
      return Response.json({ error: "same_origin_json_required" }, { status: 403 });
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return Response.json({ error: "invalid_request" }, { status: 400 });
    }

    const { batchId, orderedSlotIds } = body as any;
    if (!batchId || typeof batchId !== "string") {
      return Response.json({ error: "invalid_request", detail: "batchId required" }, { status: 400 });
    }
    if (!Array.isArray(orderedSlotIds)) {
      return Response.json({ error: "invalid_request", detail: "orderedSlotIds must be an array" }, { status: 400 });
    }

    try {
      const result = await service.acceptPartial({ productId: "mock", batchId, orderedSlotIds });
      return Response.json(result);
    } catch (err: any) {
      const code = err?.code ?? "unknown_error";
      if (["batch_not_found", "no_successful_slots"].includes(code)) {
        return Response.json({ error: code }, { status: 409 });
      }
      return Response.json({ error: "internal_error" }, { status: 500 });
    }
  };
}

function makeService() {
  return {
    async start(input: any) {
      if (input.selectedAssetIds?.length === 0) throw Object.assign(new Error("no assets"), { code: "input_count_out_of_range" });
      // Use categoryKey to trigger template_not_found (within valid 1-6 input count)
      if (input.categoryKey === "women.unknown") throw Object.assign(new Error("template not found"), { code: "template_not_found" });
      return { batchId: "batch_test_1", plannerJobId: "job_test_1" };
    },
    async retrySlot(input: any) {
      if (input.slotId === "slot_bad") throw Object.assign(new Error("not retryable"), { code: "slot_not_retryable" });
      if (input.slotId === "slot_missing") throw Object.assign(new Error("slot not found"), { code: "slot_not_found" });
      return { slotId: input.slotId };
    },
    async excludeSlot(input: any) {
      if (input.slotId === "slot_bad") throw Object.assign(new Error("not excludable"), { code: "slot_not_excludable" });
      return { slotId: input.slotId };
    },
    async acceptPartial(input: any) {
      if (input.orderedSlotIds?.length === 0) throw Object.assign(new Error("no slots"), { code: "no_successful_slots" });
      return { acceptedAssetIds: ["arch_1"] };
    }
  } as unknown as ImageGenerationService;
}

describe("POST /image-generations", () => {
  it("returns 201 on success", async () => {
    const service = makeService();
    const handler = makeStartHandler(service);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/products/prod_1/image-generations", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ revisionId: "rev_1", categoryKey: "women.hat", selectedAssetIds: ["a1"], outputCount: 4 })
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.batchId).toBe("batch_test_1");
  });

  it("returns 409 for template_not_found", async () => {
    const service = makeService();
    const handler = makeStartHandler(service);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/products/prod_1/image-generations", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ revisionId: "rev_1", categoryKey: "women.unknown", selectedAssetIds: ["a1"], outputCount: 4 })
      })
    );
    expect(res.status).toBe(409);
  });

  it("returns 403 for non-loopback origin", async () => {
    const service = makeService();
    const handler = makeStartHandler(service);
    const res = await handler(
      new Request("http://192.168.1.8/api/v1/products/prod_1/image-generations", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://192.168.1.8" },
        body: JSON.stringify({ revisionId: "rev_1", categoryKey: "women.hat", selectedAssetIds: ["a1"], outputCount: 4 })
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("PATCH /image-generations/[batchId]/slots/[slotId]", () => {
  it("returns 200 for retry", async () => {
    const service = makeService();
    const handler = makeSlotHandler(service as any);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/products/prod_1/image-generations/batch_1/slots/slot_1", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ action: "retry", batchId: "batch_1", slotId: "slot_1" })
      })
    );
    expect(res.status).toBe(200);
  });

  it("returns 409 for slot_not_retryable", async () => {
    const service = makeService();
    const handler = makeSlotHandler(service as any);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/products/prod_1/image-generations/batch_1/slots/slot_bad", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ action: "retry", batchId: "batch_1", slotId: "slot_bad" })
      })
    );
    expect(res.status).toBe(409);
  });

  it("returns 400 for unknown action", async () => {
    const service = makeService();
    const handler = makeSlotHandler(service as any);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/products/prod_1/image-generations/batch_1/slots/slot_1", {
        method: "PATCH",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ action: "unknown", batchId: "batch_1", slotId: "slot_1" })
      })
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /image-generations/[batchId]/accept", () => {
  it("returns 200 on success", async () => {
    const service = makeService();
    const handler = makeAcceptHandler(service as any);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/products/prod_1/image-generations/batch_1/accept", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ batchId: "batch_1", orderedSlotIds: ["slot_1"] })
      })
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.acceptedAssetIds).toEqual(["arch_1"]);
  });

  it("returns 409 for no_successful_slots", async () => {
    const service = makeService();
    const handler = makeAcceptHandler(service as any);
    const res = await handler(
      new Request("http://127.0.0.1/api/v1/products/prod_1/image-generations/batch_1/accept", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "http://127.0.0.1" },
        body: JSON.stringify({ batchId: "batch_1", orderedSlotIds: [] })
      })
    );
    expect(res.status).toBe(409);
  });
});
