import { rejectNonLoopback, rejectUnsafeBrowserMutation } from "../../../../../../server/auth/loopback";

type Context = { params: Promise<{ productId: string }> };

export interface MiaoshouRetryPort {
  retryMiaoshouEditAfterNoChange(productId: string): Promise<{
    approvalSnapshotId: string;
    syncId: string;
    jobId: string;
  }>;
}

export function createPostHandler(dependencies: { approvals: MiaoshouRetryPort }) {
  return async function post(request: Request, context: Context): Promise<Response> {
    const rejected = rejectNonLoopback(request) ?? rejectUnsafeBrowserMutation(request);
    if (rejected) return rejected;
    const { productId } = await context.params;
    if (!productId) return Response.json({ error: "invalid_request" }, { status: 400 });
    try {
      const result = await dependencies.approvals.retryMiaoshouEditAfterNoChange(productId);
      return Response.json(result, { status: 202 });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "miaoshou_retry_failed";
      if (["retry_not_allowed", "revision_changed", "writeback_in_progress"].includes(code)) {
        return Response.json({ error: code }, { status: 409 });
      }
      return Response.json({ error: "miaoshou_retry_failed" }, { status: 500 });
    }
  };
}

export async function POST(request: Request, context: Context): Promise<Response> {
  const { getServerServices } = await import("../../../../../../server/composition");
  return createPostHandler({ approvals: (await getServerServices()).approvals })(request, context);
}
