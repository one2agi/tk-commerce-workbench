import type { ImageRole } from "./score-image.js";

export interface CanvasCandidate {
  assetId: string;
  url: string;
  role: ImageRole;
  score: number;
  perceptualHash: string;
}

const ROLE_ORDER: Readonly<Record<ImageRole, number>> = { primary: 0, angle: 1, detail: 2, sku: 3 };

export function selectCanvasInputs(input: {
  candidates: ReadonlyArray<CanvasCandidate>;
  referenceUrls: ReadonlyArray<string>;
  capacity: number;
}) {
  if (!Number.isInteger(input.capacity) || input.capacity < 1) throw new Error("Canvas capacity must be positive");
  const seenHashes = new Set<string>();
  const productImages = [...input.candidates]
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role] || b.score - a.score)
    .filter((candidate) => {
      if (seenHashes.has(candidate.perceptualHash)) return false;
      seenHashes.add(candidate.perceptualHash);
      return true;
    })
    .slice(0, input.capacity);
  if (productImages.length === 0) throw new Error("at least one product image is required");
  const remaining = input.capacity - productImages.length;
  const usedUrls = new Set(productImages.map((candidate) => candidate.url));
  const referenceUrls = [...new Set(input.referenceUrls)].filter((url) => !usedUrls.has(url)).slice(0, remaining);
  return { productImages, referenceUrls, totalCount: productImages.length + referenceUrls.length };
}
