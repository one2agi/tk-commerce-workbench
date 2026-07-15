export type ImageRole = "primary" | "angle" | "detail" | "sku";
export type ImageRejectionReason = "low_resolution" | "watermark" | "collage" | "non_product" | "duplicate" | null;

export interface ImageSignals {
  width: number;
  height: number;
  perceptualHash: string;
  clarity: number;
  duplicateDistance: number;
  watermarkProbability: number;
  collageProbability: number;
  nonProductProbability: number;
  visualScore: number;
  sourceKind: "main" | "detail" | "sku";
}

export function scoreImage(input: ImageSignals) {
  let rejectionReason: ImageRejectionReason = null;
  if (Math.min(input.width, input.height) < 600) rejectionReason = "low_resolution";
  else if (input.watermarkProbability >= 0.6) rejectionReason = "watermark";
  else if (input.collageProbability >= 0.6) rejectionReason = "collage";
  else if (input.nonProductProbability >= 0.6) rejectionReason = "non_product";
  else if (input.duplicateDistance < 5) rejectionReason = "duplicate";

  const resolution = Math.min(1, Math.min(input.width, input.height) / 1200);
  const score = Math.max(0, Math.min(1,
    resolution * 0.2 + input.clarity * 0.25 + input.visualScore * 0.35 +
    (1 - input.watermarkProbability) * 0.08 +
    (1 - input.collageProbability) * 0.06 +
    (1 - input.nonProductProbability) * 0.06
  ));
  const chosenRole: ImageRole = input.sourceKind === "main" ? "primary" : input.sourceKind === "sku" ? "sku" : "detail";
  return { ...input, score, chosenRole, rejectionReason };
}
