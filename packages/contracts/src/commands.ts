// Command schemas for the two human gates in the Spec:
//   1. "Start processing"        -> StartAutomationV1 (single or batched via revisionIds)
//   2. "Confirm and push to Miaoshou" -> ConfirmMiaoshouEditV1
//
// Plus the collection gate: IngestLinksV1 from the browser extension.
//
// All fields carry versioned payload shapes; commands are the boundary that must never be
// silently mutated between Web and Worker.

import { z } from "zod";

export const IngestLinksItemV1 = z.object({
  sourceUrl: z.string().url(),
  idempotencyKey: z.string().min(1)
});
export type IngestLinksItemV1 = z.infer<typeof IngestLinksItemV1>;

export const IngestLinksV1 = z.object({
  version: z.literal(1),
  batchId: z.string().min(1),
  items: z.array(IngestLinksItemV1).min(1)
});
export type IngestLinksV1 = z.infer<typeof IngestLinksV1>;
export type IngestLinksV1Input = z.input<typeof IngestLinksV1>;

export const StartAutomationV1 = z.object({
  version: z.literal(1),
  revisionIds: z.array(z.string().min(1)).min(1)
});
export type StartAutomationV1 = z.infer<typeof StartAutomationV1>;

export const ConfirmMiaoshouEditV1 = z.object({
  version: z.literal(1),
  productId: z.string().min(1),
  expectedDraftVersion: z.number().int().positive(),
  expectedListingRunId: z.string().min(1),
  expectedPricingRunId: z.string().min(1),
  expectedTemplateVersion: z.number().int().positive(),
  orderedFinalAssetIds: z.array(z.string().min(1)).min(1)
});
export type ConfirmMiaoshouEditV1 = z.infer<typeof ConfirmMiaoshouEditV1>;

// Rerun command: invalidates downstream outputs and approvals for one revision.
// The "startNode" name mirrors the Wave 2 ordering (listing | pricing | template | canvas).
export const RerunDownstreamV1 = z.object({
  version: z.literal(1),
  revisionId: z.string().min(1),
  expectedDraftVersion: z.number().int().positive(),
  startNode: z.enum(["listing", "pricing", "template", "canvas"])
});
export type RerunDownstreamV1 = z.infer<typeof RerunDownstreamV1>;

// Settings updates that only adjust per-product overrides (locale, translation style).
// Secrets never enter this command.
export const UpdateProductOverridesV1 = z.object({
  version: z.literal(1),
  productId: z.string().min(1),
  targetLocale: z.string().min(2).optional(),
  translationStyle: z.string().min(1).optional()
});
export type UpdateProductOverridesV1 = z.infer<typeof UpdateProductOverridesV1>;
