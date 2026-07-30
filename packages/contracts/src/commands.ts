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

const DetailImageUrl = z.string().url().refine((value) => {
  const protocol = new URL(value).protocol;
  return protocol === "http:" || protocol === "https:";
}, "image URL must use http or https");

const ValidatedProductImageUrl = DetailImageUrl.superRefine((value, context) => {
  const url = new URL(value);
  const pathname = decodeURIComponent(url.pathname).toLowerCase();
  if (
    pathname.endsWith(".svg")
    || /(?:^|[-_/])(?:sprite|icon|logo|avatar|placeholder)(?:[-_.\\/]|$)/u.test(pathname)
    || /-\d+-tps-\d+-\d+\.(?:svg|png|jpe?g|webp|gif)$/u.test(pathname)
    || /(?:^|\/)\d{1,3}-\d{1,3}\.(?:png|gif)$/u.test(pathname)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "image URL must reference a product raster image"
    });
  }
});

const Detail1688Url = z.string().url().refine((value) => {
  const hostname = new URL(value).hostname.toLowerCase();
  return hostname === "1688.com" || hostname.endsWith(".1688.com");
}, "sourceUrl must belong to 1688.com");

export const IngestLocalCaptureItemV1 = z.object({
  sourceItemId: z.string().regex(/^\d+$/),
  sourceUrl: Detail1688Url,
  title: z.string().trim().min(1).max(500),
  mainImages: z.array(DetailImageUrl),
  detailImages: z.array(DetailImageUrl),
  attributes: z.array(z.object({
    name: z.string().trim().min(1),
    value: z.string().trim().min(1)
  })).optional(),
  skuText: z.array(z.string().trim().min(1)).optional(),
  capturedAt: z.string().datetime({ offset: true }),
  captureQuality: z.literal("detail_page"),
  idempotencyKey: z.string().min(1)
}).superRefine((item, context) => {
  if (item.mainImages.length + item.detailImages.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mainImages"],
      message: "at least one product image is required"
    });
  }
});
export type IngestLocalCaptureItemV1 = z.infer<typeof IngestLocalCaptureItemV1>;

export const IngestLocalCapturesV1 = z.object({
  version: z.literal(1),
  batchId: z.string().min(1),
  items: z.array(IngestLocalCaptureItemV1).min(1)
});
export type IngestLocalCapturesV1 = z.infer<typeof IngestLocalCapturesV1>;

const CaptureSectionState = z.enum(["captured", "absent"]);

export const IngestLocalCaptureItemV2 = z.object({
  sourceItemId: z.string().regex(/^\d+$/),
  sourceUrl: Detail1688Url,
  title: z.string().trim().min(1).max(500).refine(
    (value) => !/(?:登录页面|全球领先的采购批发平台|使用\s*1688\s*\/\s*淘宝App\s*扫码登录|验证码|密码登录|短信登录|免费注册)/u.test(value)
      && !/(?:有限公司|有限责任公司|旗舰店|官方店)\s*$/u.test(value),
    "title must be a product title"
  ),
  mainImages: z.array(ValidatedProductImageUrl).min(1),
  detailImages: z.array(ValidatedProductImageUrl),
  descriptionText: z.string().trim().max(20_000).optional(),
  attributes: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(500)
  })).optional(),
  skuAttributes: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    values: z.array(z.object({
      name: z.string().trim().min(1).max(200),
      imageUrl: ValidatedProductImageUrl.optional()
    })).min(1)
  })).optional(),
  skuText: z.array(z.string().trim().min(1).max(500)).optional(),
  capturedAt: z.string().datetime({ offset: true }),
  captureQuality: z.literal("detail_page_validated"),
  diagnostics: z.object({
    version: z.literal(1),
    pageKind: z.literal("offer_detail"),
    titleSource: z.enum(["page_context", "json_ld", "product_heading"]),
    stableForMs: z.number().int().min(2_000),
    detailSection: CaptureSectionState,
    attributesSection: CaptureSectionState,
    skuSection: CaptureSectionState,
    acceptedMainImages: z.number().int().nonnegative(),
    acceptedDetailImages: z.number().int().nonnegative(),
    rejectedImages: z.number().int().nonnegative()
  }),
  idempotencyKey: z.string().min(1)
}).superRefine((item, context) => {
  const match = /\/offer\/(\d+)\.html/i.exec(item.sourceUrl);
  if (match?.[1] !== item.sourceItemId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceItemId"],
      message: "sourceItemId must match sourceUrl"
    });
  }
  if (item.diagnostics.acceptedMainImages !== item.mainImages.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diagnostics", "acceptedMainImages"],
      message: "acceptedMainImages must match mainImages"
    });
  }
  if (item.diagnostics.acceptedDetailImages !== item.detailImages.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diagnostics", "acceptedDetailImages"],
      message: "acceptedDetailImages must match detailImages"
    });
  }
  if (item.diagnostics.detailSection === "captured"
    && item.detailImages.length === 0
    && !item.descriptionText?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diagnostics", "detailSection"],
      message: "captured detail section must contain images or text"
    });
  }
  if (item.diagnostics.attributesSection === "captured" && !item.attributes?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attributes"],
      message: "captured attributes section must contain attributes"
    });
  }
  if (item.diagnostics.skuSection === "captured" && !item.skuAttributes?.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["skuAttributes"],
      message: "captured sku section must contain sku attributes"
    });
  }
});
export type IngestLocalCaptureItemV2 = z.infer<typeof IngestLocalCaptureItemV2>;

export const IngestLocalCapturesV2 = z.object({
  version: z.literal(2),
  batchId: z.string().min(1),
  items: z.array(IngestLocalCaptureItemV2).min(1)
});
export type IngestLocalCapturesV2 = z.infer<typeof IngestLocalCapturesV2>;

const CnyMoneyWire = z.object({
  amountMinor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  currency: z.literal("CNY")
});

const CnyPriceRangeWire = z.object({
  minAmountMinor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  maxAmountMinor: z.string().regex(/^(?:0|[1-9]\d*)$/),
  currency: z.literal("CNY")
}).refine(
  (range) => BigInt(range.minAmountMinor) <= BigInt(range.maxAmountMinor),
  "minimum source price must not exceed maximum source price"
);

const CaptureEvidenceState = z.enum(["captured", "source_absent", "capture_failed"]);

const ConcreteSkuV3 = z.object({
  skuId: z.string().trim().min(1).max(200),
  attributes: z.record(
    z.string().trim().min(1).max(100),
    z.string().trim().min(1).max(200)
  ),
  priceWire: CnyMoneyWire.nullable(),
  stock: z.number().int().nonnegative().nullable(),
  imageUrl: ValidatedProductImageUrl.nullable(),
  weightKg: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).nullable().optional(),
  dimensionsCm: z.object({
    lengthCm: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    widthCm: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    heightCm: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  }).nullable().optional()
});

export const IngestLocalCaptureItemV3 = z.object({
  sourceItemId: z.string().regex(/^\d+$/),
  sourceUrl: Detail1688Url,
  title: z.string().trim().min(1).max(500).refine(
    (value) => !/(?:登录页面|全球领先的采购批发平台|使用\s*1688\s*\/\s*淘宝App\s*扫码登录|验证码|密码登录|短信登录|免费注册)/u.test(value)
      && !/(?:有限公司|有限责任公司|旗舰店|官方店)\s*$/u.test(value),
    "title must be a product title"
  ),
  mainImages: z.array(ValidatedProductImageUrl).min(1),
  detailImages: z.array(ValidatedProductImageUrl),
  descriptionText: z.string().trim().max(20_000).optional(),
  itemNumber: z.string().trim().min(1).max(200).nullable(),
  category: z.string().trim().min(1).max(500).nullable(),
  sourcePriceWire: CnyMoneyWire.nullable(),
  sourcePriceRangeWire: CnyPriceRangeWire.nullable(),
  sourceStock: z.number().int().nonnegative().nullable(),
  weightKg: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/).nullable(),
  dimensionsCm: z.object({
    lengthCm: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    widthCm: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/),
    heightCm: z.string().regex(/^(?:0|[1-9]\d*)(?:\.\d+)?$/)
  }).nullable(),
  attributes: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(500)
  })),
  saleAttributes: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    value: z.string().trim().min(1).max(500)
  })),
  skuAttributes: z.array(z.object({
    name: z.string().trim().min(1).max(100),
    values: z.array(z.object({
      name: z.string().trim().min(1).max(200),
      imageUrl: ValidatedProductImageUrl.optional()
    })).min(1)
  })),
  skuText: z.array(z.string().trim().min(1).max(500)).optional(),
  colors: z.array(z.string().trim().min(1).max(200)),
  sizes: z.array(z.string().trim().min(1).max(200)),
  skus: z.array(ConcreteSkuV3),
  capturedAt: z.string().datetime({ offset: true }),
  captureQuality: z.enum(["detail_page_complete", "detail_page_partial"]),
  diagnostics: z.object({
    version: z.literal(2),
    pageKind: z.literal("offer_detail"),
    titleSource: z.enum([
      "page_context",
      "json_ld",
      "product_heading",
      "document_title"
    ]),
    stableForMs: z.number().int().min(2_000),
    fieldEvidence: z.object({
      title: CaptureEvidenceState,
      mainImages: CaptureEvidenceState,
      detail: CaptureEvidenceState,
      attributes: CaptureEvidenceState,
      price: CaptureEvidenceState,
      stock: CaptureEvidenceState,
      skus: CaptureEvidenceState,
      weight: CaptureEvidenceState,
      dimensions: CaptureEvidenceState
    }),
    expectedSkuCount: z.number().int().nonnegative().nullable(),
    capturedSkuCount: z.number().int().nonnegative(),
    acceptedMainImages: z.number().int().nonnegative(),
    acceptedDetailImages: z.number().int().nonnegative(),
    rejectedImages: z.number().int().nonnegative(),
    warnings: z.array(z.string().trim().min(1).max(100))
  }),
  idempotencyKey: z.string().min(1)
}).superRefine((item, context) => {
  const match = /\/offer\/(\d+)\.html/i.exec(item.sourceUrl);
  if (match?.[1] !== item.sourceItemId) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceItemId"],
      message: "sourceItemId must match sourceUrl"
    });
  }
  if (item.diagnostics.acceptedMainImages !== item.mainImages.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diagnostics", "acceptedMainImages"],
      message: "acceptedMainImages must match mainImages"
    });
  }
  if (item.diagnostics.acceptedDetailImages !== item.detailImages.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diagnostics", "acceptedDetailImages"],
      message: "acceptedDetailImages must match detailImages"
    });
  }
  if (item.diagnostics.capturedSkuCount !== item.skus.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diagnostics", "capturedSkuCount"],
      message: "capturedSkuCount must match concrete SKU rows"
    });
  }
  if (item.sourcePriceWire && item.sourcePriceRangeWire
    && item.sourcePriceWire.amountMinor !== item.sourcePriceRangeWire.minAmountMinor) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourcePriceWire"],
      message: "sourcePriceWire must equal the minimum source price"
    });
  }
  const duplicateSkuIds = item.skus.length !== new Set(item.skus.map((sku) => sku.skuId)).size;
  if (duplicateSkuIds) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["skus"],
      message: "concrete SKU ids must be unique"
    });
  }
  const evidence = item.diagnostics.fieldEvidence;
  const expectedSkuMismatch = item.diagnostics.expectedSkuCount !== null
    && item.diagnostics.expectedSkuCount !== item.skus.length;
  const hasCaptureFailure = Object.values(evidence).includes("capture_failed");
  if (item.captureQuality === "detail_page_complete" && (hasCaptureFailure || expectedSkuMismatch)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["captureQuality"],
      message: "complete captures cannot contain failed or incomplete fields"
    });
  }
  if (item.captureQuality === "detail_page_partial" && !hasCaptureFailure && !expectedSkuMismatch) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["captureQuality"],
      message: "partial captures must identify an incomplete field"
    });
  }
  if (evidence.detail === "captured"
    && item.detailImages.length === 0
    && !item.descriptionText?.trim()) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["diagnostics", "fieldEvidence", "detail"],
      message: "captured detail must contain images or text"
    });
  }
  if (evidence.attributes === "captured" && item.attributes.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["attributes"],
      message: "captured attributes must not be empty"
    });
  }
  if (evidence.price === "captured"
    && !item.sourcePriceWire
    && !item.skus.some((sku) => sku.priceWire !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourcePriceWire"],
      message: "captured price evidence must contain a source or SKU price"
    });
  }
  if (evidence.stock === "captured"
    && item.sourceStock === null
    && !item.skus.some((sku) => sku.stock !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourceStock"],
      message: "captured stock evidence must contain a source or SKU stock"
    });
  }
  if (evidence.skus === "captured" && item.skus.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["skus"],
      message: "captured SKU evidence must contain concrete SKU rows"
    });
  }
});
export type IngestLocalCaptureItemV3 = z.infer<typeof IngestLocalCaptureItemV3>;

export const IngestLocalCapturesV3 = z.object({
  version: z.literal(3),
  batchId: z.string().min(1),
  items: z.array(IngestLocalCaptureItemV3).min(1)
});
export type IngestLocalCapturesV3 = z.infer<typeof IngestLocalCapturesV3>;

export type IngestLocalCapturesResult = Readonly<{
  accepted: number;
  products: ReadonlyArray<{
    sourceItemId: string;
    productId: string;
    revisionId: string;
    created: boolean;
  }>;
  rejected: ReadonlyArray<{
    sourceItemId?: string;
    sourceUrl?: string;
    reason: string;
  }>;
}>;

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
  expectedTemplateVersion: z.number().int().positive(),
  orderedFinalAssetIds: z.array(z.string().min(1)).min(1)
});
export type ConfirmMiaoshouEditV1 = z.infer<typeof ConfirmMiaoshouEditV1>;

// Rerun command: invalidates downstream outputs and approvals for one revision.
// The "startNode" name mirrors the current MVP ordering (listing | template | canvas).
export const RerunDownstreamV1 = z.object({
  version: z.literal(1),
  revisionId: z.string().min(1),
  expectedDraftVersion: z.number().int().positive(),
  startNode: z.enum(["listing", "template", "canvas"])
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
