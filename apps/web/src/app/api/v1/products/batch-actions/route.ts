import { z } from "zod";
import type { ConfirmMiaoshouEditV1 as ConfirmCommand } from "@tk/contracts";

import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../server/auth/loopback";

const BatchActionRequest = z.object({
  action: z.enum(["confirm_miaoshou_edit", "retry_from_failure"]),
  productIds: z.array(z.string().min(1)).min(1).max(50)
});

type ProductPreviewPort = {
  preview(productId: string): Promise<{
    productId: string;
    draftVersion: number;
    listingRunId: string;
    pricingRunId?: string | null;
    templateVersion: number;
    orderedFinalAssetIds: readonly string[];
  } | null>;
};

type ApprovalPort = {
  confirmAndEnqueue(command: ConfirmCommand): Promise<{ approvalSnapshotId: string; syncId: string }>;
};

type RerunPort = {
  enqueueProductRetry(productId: string): Promise<void>;
};

export function createPostHandler(dependencies: {
  products: ProductPreviewPort;
  approvals: ApprovalPort;
  reruns: RerunPort;
}) {
  return async function post(request: Request): Promise<Response> {
    const rejected = rejectNonLoopback(request) ?? rejectUnsafeBrowserMutation(request);
    if (rejected) return rejected;

    const parsed = BatchActionRequest.safeParse(await request.json().catch(() => null));
    if (!parsed.success) return Response.json({ error: "invalid_request" }, { status: 400 });

    const results: Array<{ productId: string; ok: boolean; code?: string }> = [];
    for (const productId of parsed.data.productIds) {
      try {
        if (parsed.data.action === "confirm_miaoshou_edit") {
          const preview = await dependencies.products.preview(productId);
          if (!preview || preview.orderedFinalAssetIds.length === 0) {
            throw Object.assign(new Error("approval_mapping_not_ready"), { code: "approval_mapping_not_ready" });
          }
          await dependencies.approvals.confirmAndEnqueue({
            version: 1,
            productId,
            expectedDraftVersion: preview.draftVersion,
            expectedListingRunId: preview.listingRunId,
            expectedTemplateVersion: preview.templateVersion,
            orderedFinalAssetIds: preview.orderedFinalAssetIds.map(String)
          });
        } else {
          await dependencies.reruns.enqueueProductRetry(productId);
        }
        results.push({ productId, ok: true });
      } catch (error) {
        results.push({
          productId,
          ok: false,
          code: (error as { code?: string }).code ?? "batch_action_failed"
        });
      }
    }

    return Response.json({ results }, { status: 202 });
  };
}

export async function POST(request: Request): Promise<Response> {
  const { getServerServices } = await import("../../../../../server/composition");
  const services = await getServerServices();
  return createPostHandler({
    products: services.products,
    approvals: services.approvals,
    reruns: services.productReruns
  })(request);
}
