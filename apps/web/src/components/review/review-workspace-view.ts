import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

export type ReviewWorkspaceView = ProductWorkspaceV1 & Readonly<{
  reviewFacts: Readonly<{
    skuCount: number | null;
    orderedFinalImages: ReadonlyArray<Readonly<{ assetId: string; previewUrl: string }>>;
    stock: string | null;
    weightKg: string | null;
    dimensions: Readonly<{ lengthCm: string; widthCm: string; heightCm: string }> | null;
    canonicalMiaoshouTarget: string | null;
  }>;
}>;
