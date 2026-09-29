import type { ProductFactsData, ProductWorkspaceV1 } from "@tk/contracts/read-models";

export type ReviewWorkspaceView = ProductWorkspaceV1 & Readonly<{
  reviewFacts: ProductFactsData;
}>;

