import type { RerunDownstreamV1 } from "@tk/contracts";
import type { ProductPoolItemV1, ProductWorkspaceV1 } from "@tk/contracts/read-models";

type ProductReader = {
  list(): Promise<{ items: ProductPoolItemV1[] }>;
  get(productId: string): Promise<ProductWorkspaceV1 | null>;
};

type RerunCommandPort = {
  enqueue(command: RerunDownstreamV1, productId: string): Promise<unknown>;
};

function retryStartNode(item: ProductPoolItemV1): RerunDownstreamV1["startNode"] | null {
  if (item.listing === "failed" || item.listing === "needs_input") return "listing";
  if (item.warningCodes.includes("missing_weight") && item.listing === "ready") return "template";
  if (item.canvas === "failed" || (item.canvas === "partial" && item.usableCanvasOutputCount === 0)) return "canvas";
  return null;
}

export class ProductRerunService {
  constructor(private readonly products: ProductReader, private readonly reruns: RerunCommandPort) {}

  async enqueueProductRetry(productId: string): Promise<void> {
    const [pool, workspace] = await Promise.all([
      this.products.list(),
      this.products.get(productId)
    ]);
    const item = pool.items.find((candidate) => String(candidate.productId) === productId);
    if (!item || !workspace) {
      throw Object.assign(new Error("product_not_found"), { code: "product_not_found" });
    }
    const startNode = retryStartNode(item);
    if (!startNode) {
      throw Object.assign(new Error("product_retry_not_available"), { code: "product_retry_not_available" });
    }
    await this.reruns.enqueue({
      version: 1,
      revisionId: String(workspace.revisionId),
      expectedDraftVersion: workspace.draftVersion,
      startNode
    }, productId);
  }
}
