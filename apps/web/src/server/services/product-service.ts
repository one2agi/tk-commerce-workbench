import {
  assetId,
  miaoshouDetailId,
  productId,
  productRevisionId,
  sourceItemId,
  templateId
} from "@tk/contracts/ids";
import type { MoneyCurrency } from "@tk/contracts/quantities";
import type { CanvasState } from "@tk/contracts/states";
import type {
  ApprovalPreviewV1,
  ProductPoolItemV1,
  ProductWorkspaceV1
} from "@tk/contracts/read-models";
import type { ReviewWorkspaceView } from "../../components/review/review-workspace-view";
import { sourceImageProxyPath } from "../source-image-url";

export interface QueryPort {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

const PRODUCT_POOL_SQL = `
SELECT p.id AS product_id,
       revision.id AS current_revision_id,
       p.source_url,
       p.created_at AS collected_at,
       p.updated_at AS updated_at,
       p.source_item_id,
       revision.source_title AS canonical_source_title,
       draft.title AS target_title,
       p.canonical_success_detail_id,
       p.locale,
       p.currency,
       pricing.final_price_minor AS price_minor,
       revision.source_payload #>> '{sourcePriceWire,amountMinor}' AS source_price_minor,
       revision.source_payload->'mainImages' AS source_main_images,
       revision.source_payload->'detailImages' AS source_detail_images,
       COALESCE(archived_source_images.items, '[]'::jsonb) AS archived_source_images,
	       COALESCE(
	         final_thumbnail.preview_url,
	         archived_thumbnail.preview_url,
	         (
	           SELECT CASE
	                    WHEN jsonb_typeof(image) = 'string' THEN image #>> '{}'
	                    ELSE image->>'url'
	                  END
	           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(revision.source_payload->'mainImages') = 'array'
               THEN revision.source_payload->'mainImages'
               ELSE '[]'::jsonb
             END
           ) image
           WHERE image ? 'url'
           LIMIT 1
         ),
         (
           SELECT CASE
                    WHEN jsonb_typeof(image) = 'string' THEN image #>> '{}'
                    ELSE image->>'url'
                  END
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(revision.source_payload->'detailImages') = 'array'
               THEN revision.source_payload->'detailImages'
               ELSE '[]'::jsonb
             END
           ) image
           WHERE image ? 'url'
           LIMIT 1
         )
       ) AS thumbnail_url,
       (
         jsonb_array_length(
           CASE
             WHEN jsonb_typeof(revision.source_payload->'mainImages') = 'array'
             THEN revision.source_payload->'mainImages'
             ELSE '[]'::jsonb
           END
         )
         +
         jsonb_array_length(
           CASE
             WHEN jsonb_typeof(revision.source_payload->'detailImages') = 'array'
             THEN revision.source_payload->'detailImages'
             ELSE '[]'::jsonb
           END
         )
       )::integer AS source_image_count,
       revision.source_payload->>'captureQuality' AS source_capture_quality,
       COALESCE(asset_totals.image_count, 0)::integer AS image_count,
       COALESCE(canvas.outputs, '[]'::jsonb) AS canvas_outputs,
       p.state_source,
       p.state_automation,
       p.state_asset_archive,
       p.state_listing,
       p.state_canvas,
       latest_automation_run.state AS latest_automation_run_state,
       latest_canvas_job.status AS latest_canvas_job_status,
       latest_canvas_job.error AS latest_canvas_job_error,
       latest_blocking_job.kind AS latest_blocking_job_kind,
       latest_blocking_job.status AS latest_blocking_job_status,
       latest_blocking_job.error AS latest_blocking_job_error,
       p.state_approval,
       p.state_miaoshou_edit,
       COALESCE(revision.working_draft->'warningCodes', '[]'::jsonb) AS warning_codes
FROM products p
JOIN LATERAL (
  SELECT * FROM product_revisions candidate
  WHERE candidate.product_id = p.id
  ORDER BY candidate.draft_version DESC, candidate.created_at DESC
  LIMIT 1
) revision ON true
LEFT JOIN LATERAL (
  SELECT title FROM listing_drafts candidate
  WHERE candidate.revision_id = revision.id
  ORDER BY candidate.draft_version DESC, candidate.created_at DESC
  LIMIT 1
) draft ON true
	LEFT JOIN LATERAL (
	  SELECT final_price_minor FROM pricing_runs candidate
	  WHERE candidate.revision_id = revision.id
	  ORDER BY candidate.created_at DESC
	  LIMIT 1
	) pricing ON true
	LEFT JOIN LATERAL (
	  SELECT COALESCE(
	           CASE
	             WHEN candidate.remote_url ~ '^https?://'
	             THEN candidate.remote_url
	           END,
	           CASE
	             WHEN candidate.local_path IS NOT NULL
	             THEN '/api/v1/assets/' || candidate.id || '/content'
	           END
	         ) AS preview_url
	  FROM jsonb_array_elements_text(
	    CASE
	      WHEN jsonb_typeof(revision.working_draft->'finalAssetOrder') = 'array'
	      THEN revision.working_draft->'finalAssetOrder'
	      ELSE '[]'::jsonb
	    END
	  ) WITH ORDINALITY ordered(asset_id, ord)
	  JOIN assets candidate ON candidate.id = ordered.asset_id AND candidate.state = 'ready'
	  WHERE candidate.remote_url ~ '^https?://' OR candidate.local_path IS NOT NULL
	  ORDER BY ordered.ord
	  LIMIT 1
	) final_thumbnail ON true
	LEFT JOIN LATERAL (
	  SELECT '/api/v1/assets/' || candidate.id || '/content' AS preview_url
	  FROM assets candidate
	  WHERE candidate.revision_id = revision.id
	    AND candidate.state = 'ready'
	    AND candidate.local_path IS NOT NULL
	  ORDER BY CASE WHEN candidate.kind = 'main' THEN 0 ELSE 1 END, candidate.created_at ASC, candidate.id
	  LIMIT 1
		) archived_thumbnail ON true
	LEFT JOIN LATERAL (
	  SELECT COALESCE(
	    jsonb_agg(
	      jsonb_build_object(
	        'remoteUrl', candidate.remote_url,
	        'localUrl', '/api/v1/assets/' || candidate.id || '/content'
	      )
	      ORDER BY candidate.created_at ASC, candidate.id
	    ),
	    '[]'::jsonb
	  ) AS items
	  FROM assets candidate
	  WHERE candidate.revision_id = revision.id
	    AND candidate.state = 'ready'
	    AND candidate.local_path IS NOT NULL
	) archived_source_images ON true
		LEFT JOIN LATERAL (
	  SELECT count(*)::integer AS image_count FROM assets candidate
	  WHERE candidate.revision_id = revision.id
) asset_totals ON true
LEFT JOIN LATERAL (
  SELECT outputs FROM canvas_runs candidate
  WHERE candidate.revision_id = revision.id
  ORDER BY candidate.created_at DESC
  LIMIT 1
) canvas ON true
LEFT JOIN LATERAL (
  SELECT state FROM automation_runs candidate
  WHERE candidate.revision_id = revision.id
  ORDER BY candidate.created_at DESC
  LIMIT 1
) latest_automation_run ON true
LEFT JOIN LATERAL (
  SELECT status, error FROM jobs candidate
  WHERE candidate.kind = 'canvas_generate'
    AND candidate.payload->>'revisionId' = revision.id
  ORDER BY candidate.created_at DESC
  LIMIT 1
) latest_canvas_job ON true
LEFT JOIN LATERAL (
  SELECT kind, status, error FROM jobs candidate
  WHERE candidate.payload->>'revisionId' = revision.id
    AND candidate.status IN ('needs_input', 'failed')
  ORDER BY candidate.updated_at DESC, candidate.created_at DESC
  LIMIT 1
) latest_blocking_job ON true
ORDER BY p.updated_at DESC, p.id`;

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function imageUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const raw = typeof item === "string"
      ? item
      : item && typeof item === "object" && typeof (item as Record<string, unknown>).url === "string"
        ? String((item as Record<string, unknown>).url)
        : null;
    if (!raw) return [];
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? [raw] : [];
    } catch {
      return [];
    }
  });
}

function archivedSourceImageMap(value: unknown): ReadonlyMap<string, string> {
  if (!Array.isArray(value)) return new Map();
  const entries = value.flatMap((item): Array<[string, string]> => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    return typeof row.remoteUrl === "string" && typeof row.localUrl === "string"
      ? [[row.remoteUrl, row.localUrl]]
      : [];
  });
  return new Map(entries);
}

function originalImageUrls(row: Record<string, unknown>): string[] {
  const archived = archivedSourceImageMap(row.archived_source_images);
  const ordered = [
    ...imageUrls(row.source_main_images),
    ...imageUrls(row.source_detail_images)
  ];
  return [...new Set(ordered)].flatMap((url) => {
    const visible = archived.get(url) ?? sourceImageProxyPath(url);
    return visible ? [visible] : [];
  });
}

function processedImageUrls(value: unknown): string[] {
  return strings(value).flatMap((raw) => {
    if (/^asset_[A-Za-z0-9_-]+$/.test(raw)) {
      return [`/api/v1/assets/${encodeURIComponent(raw)}/content`];
    }
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:" ? [url.href] : [];
    } catch {
      return [];
    }
  });
}

function usableOutputCount(value: unknown): number {
  return strings(value).filter((raw) => {
    if (/^asset_[A-Za-z0-9_-]+$/.test(raw)) return true;
    try {
      const url = new URL(raw);
      return url.protocol === "http:" || url.protocol === "https:";
    } catch {
      return false;
    }
  }).length;
}

function jsonErrorCode(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const code = (value as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function effectiveAutomationState(row: Record<string, unknown>): ProductPoolItemV1["automation"] {
  const stored = requiredString(row, "state_automation") as ProductPoolItemV1["automation"];
  const blockingStatus = optionalString(row, "latest_blocking_job_status");
  if (blockingStatus === "needs_input") return "needs_input";
  if (blockingStatus === "failed") return "failed";
  const runState = optionalString(row, "latest_automation_run_state") as ProductPoolItemV1["automation"] | null;
  if (stored === "not_started" && runState && runState !== "not_started") return runState;
  return stored;
}

function effectiveListingState(row: Record<string, unknown>): ProductPoolItemV1["listing"] {
  const stored = requiredString(row, "state_listing") as ProductPoolItemV1["listing"];
  const blockingKind = optionalString(row, "latest_blocking_job_kind");
  const blockingStatus = optionalString(row, "latest_blocking_job_status");
  if (
    (blockingKind === "listing_generate" || blockingKind === "template_match") &&
    (blockingStatus === "needs_input" || blockingStatus === "failed")
  ) {
    return blockingStatus === "needs_input" ? "needs_input" : "failed";
  }
  return stored;
}

function effectiveCanvasState(row: Record<string, unknown>): ProductPoolItemV1["canvas"] {
  const stored = requiredString(row, "state_canvas") as ProductPoolItemV1["canvas"];
  const latestCanvasJobStatus = optionalString(row, "latest_canvas_job_status");
  if (latestCanvasJobStatus === "queued" || latestCanvasJobStatus === "running") return latestCanvasJobStatus;
  if (latestCanvasJobStatus === "needs_input" || latestCanvasJobStatus === "failed") return "failed";
  return stored;
}

function requiredString(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`invalid_product_projection:${key}`);
  return value;
}

function optionalString(row: Record<string, unknown>, key: string): string | null {
  return typeof row[key] === "string" ? row[key] as string : null;
}

function requiredIsoTimestamp(row: Record<string, unknown>, key: string): string {
  const value = row[key];
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "string" && value.length > 0) return value;
  throw new Error(`invalid_product_projection:${key}`);
}

function decimalEvidence(value: unknown): string | null {
  const text = typeof value === "string" ? value : null;
  return text && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text) ? text : null;
}

function integerEvidence(value: unknown): string | null {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return String(value);
  const text = typeof value === "string" ? value : null;
  return text && /^(?:0|[1-9]\d*)$/.test(text) ? text : null;
}

function dimensionEvidence(value: unknown): ReviewWorkspaceView["reviewFacts"]["dimensions"] {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  const lengthCm = decimalEvidence(source.lengthCm);
  const widthCm = decimalEvidence(source.widthCm);
  const heightCm = decimalEvidence(source.heightCm);
  return lengthCm && widthCm && heightCm ? { lengthCm, widthCm, heightCm } : null;
}

function toPoolItem(row: Record<string, unknown>): ProductPoolItemV1 {
  const currency = requiredString(row, "currency") as MoneyCurrency;
  const priceMinor = optionalString(row, "price_minor");
  const originalImages = originalImageUrls(row);
  const processedImages = processedImageUrls(row.canvas_outputs);
  const blockingCode = jsonErrorCode(row.latest_blocking_job_error);
  const warningCodes = strings(row.warning_codes);
  const combinedWarningCodes = blockingCode && !warningCodes.includes(blockingCode)
    ? [...warningCodes, blockingCode]
    : warningCodes;
  return {
    productId: productId(requiredString(row, "product_id")),
    currentRevisionId: productRevisionId(requiredString(row, "current_revision_id")),
    sourceItemId: optionalString(row, "source_item_id")
      ? sourceItemId(optionalString(row, "source_item_id")!)
      : null,
    sourceUrl: requiredString(row, "source_url"),
    thumbnailUrl: originalImages[0] ?? optionalString(row, "thumbnail_url"),
    originalImageUrls: originalImages,
    processedImageUrls: processedImages,
    collectedAt: requiredIsoTimestamp(row, "collected_at"),
    updatedAt: requiredIsoTimestamp(row, "updated_at"),
    canonicalSourceTitle: optionalString(row, "canonical_source_title"),
    targetTitle: optionalString(row, "target_title"),
    canonicalSuccessDetailId: optionalString(row, "canonical_success_detail_id")
      ? miaoshouDetailId(optionalString(row, "canonical_success_detail_id")!)
      : null,
    locale: requiredString(row, "locale"),
    currency,
    priceWire: priceMinor ? { amountMinor: priceMinor, currency } : null,
    sourcePriceWire: optionalString(row, "source_price_minor")
      ? { amountMinor: optionalString(row, "source_price_minor")!, currency: "CNY" }
      : null,
    sourceImageCount: Number(row.source_image_count ?? 0),
    sourceCaptureQuality: optionalString(row, "source_capture_quality"),
    imageCount: Number(row.image_count ?? 0),
    usableCanvasOutputCount: usableOutputCount(row.canvas_outputs),
    miaoshouSource: requiredString(row, "state_source") as ProductPoolItemV1["miaoshouSource"],
    automation: effectiveAutomationState(row),
    assetArchive: requiredString(row, "state_asset_archive") as ProductPoolItemV1["assetArchive"],
    listing: effectiveListingState(row),
    canvas: effectiveCanvasState(row),
    approval: requiredString(row, "state_approval") as ProductPoolItemV1["approval"],
    miaoshouEdit: requiredString(row, "state_miaoshou_edit") as ProductPoolItemV1["miaoshouEdit"],
    warningCodes: combinedWarningCodes
  };
}

export class ProductService {
  constructor(private readonly database: QueryPort) {}

  async list(): Promise<{ items: ProductPoolItemV1[] }> {
    const result = await this.database.query(PRODUCT_POOL_SQL);
    return { items: result.rows.map(toPoolItem) };
  }

  async get(productIdValue: string): Promise<ProductWorkspaceV1 | null> {
    const result = await this.database.query(
      `SELECT p.id AS product_id, revision.id AS revision_id,
              revision.draft_version, revision.source_title,
              revision.source_payload, revision.working_draft,
              draft.target_locale, draft.title AS target_title,
              draft.description AS target_description, draft.style AS target_style,
              draft.provider AS target_provider, draft.model AS target_model,
              draft.fallback_used AS target_fallback_used,
              pricing.id AS pricing_run_id, pricing.final_currency AS price_currency,
              pricing.final_price_minor, pricing.breakdown AS pricing_breakdown,
              canvas.id AS canvas_run_id, canvas.outputs AS canvas_outputs,
              canvas.state AS canvas_state, canvas.template_id,
              canvas.template_version,
              COALESCE(revision.working_draft->>'templateMatchedReason', 'selected') AS template_reason
       FROM products p
       JOIN LATERAL (
         SELECT * FROM product_revisions candidate
         WHERE candidate.product_id = p.id
         ORDER BY candidate.draft_version DESC, candidate.created_at DESC LIMIT 1
       ) revision ON true
       LEFT JOIN LATERAL (
         SELECT * FROM listing_drafts candidate
         WHERE candidate.revision_id = revision.id
         ORDER BY candidate.draft_version DESC, candidate.created_at DESC LIMIT 1
       ) draft ON true
       LEFT JOIN LATERAL (
         SELECT * FROM pricing_runs candidate
         WHERE candidate.revision_id = revision.id
         ORDER BY candidate.created_at DESC LIMIT 1
       ) pricing ON true
       LEFT JOIN LATERAL (
         SELECT * FROM canvas_runs candidate
         WHERE candidate.revision_id = revision.id
         ORDER BY candidate.created_at DESC LIMIT 1
       ) canvas ON true
       WHERE p.id = $1`,
      [productIdValue]
    );
    const row = result.rows[0];
    if (!row) return null;
    const source = (row.source_payload && typeof row.source_payload === "object"
      ? row.source_payload : {}) as Record<string, unknown>;
    const draft = (row.working_draft && typeof row.working_draft === "object"
      ? row.working_draft : {}) as Record<string, unknown>;
    return {
      productId: productId(requiredString(row, "product_id")),
      revisionId: productRevisionId(requiredString(row, "revision_id")),
      draftVersion: Number(row.draft_version),
      originalListing: typeof row.source_title === "string" ? {
        sourceTitle: row.source_title,
        description: typeof source.description === "string" ? source.description : "",
        sourceAttributes: Array.isArray(source.sourceAttributes) ? source.sourceAttributes as Array<{ name: string; value: string }> : [],
        saleAttributes: Array.isArray(source.saleAttributes) ? source.saleAttributes as Array<{ name: string; value: string }> : [],
        mainImages: imageUrls(source.mainImages),
        detailImages: imageUrls(source.detailImages)
      } : null,
      target: typeof row.target_title === "string" ? {
        locale: typeof row.target_locale === "string" ? row.target_locale : "th-TH",
        title: row.target_title,
        description: typeof row.target_description === "string" ? row.target_description : "",
        style: typeof row.target_style === "string" ? row.target_style : "default",
        provider: typeof row.target_provider === "string" ? row.target_provider : "rule",
        model: typeof row.target_model === "string" ? row.target_model : "deterministic",
        fallbackUsed: row.target_fallback_used === true
      } : null,
      pricing: typeof row.pricing_run_id === "string" ? {
        pricingRunId: row.pricing_run_id,
        currency: String(row.price_currency ?? "THB") as MoneyCurrency,
        finalPriceWire: typeof row.final_price_minor === "string"
          ? {
              amountMinor: row.final_price_minor,
              currency: String(row.price_currency ?? "THB") as MoneyCurrency
            }
          : null,
        breakdown: row.pricing_breakdown && typeof row.pricing_breakdown === "object"
          ? row.pricing_breakdown as Record<string, string>
          : {},
        exchangeRate: null
      } : null,
      template: typeof row.template_id === "string" ? {
        templateId: templateId(row.template_id),
        version: Number(row.template_version),
        matchedReason: typeof row.template_reason === "string" ? row.template_reason : "selected"
      } : null,
      canvas: typeof row.canvas_run_id === "string" ? {
        runId: row.canvas_run_id,
        outputs: strings(row.canvas_outputs),
        state: String(row.canvas_state) as CanvasState
      } : null,
      finalAssetOrder: strings(draft.finalAssetOrder).map(assetId),
      warningCodes: strings(draft.warningCodes)
    };
  }

  async preview(productIdValue: string): Promise<ApprovalPreviewV1 | null> {
    const result = await this.database.query(
      `SELECT p.id AS product_id, p.locale, p.currency, p.canonical_success_detail_id,
              revision.draft_version,
              listing.id AS listing_run_id,
              pricing.id AS pricing_run_id, pricing.final_price_minor,
              COALESCE(canvas.template_version,
                NULLIF(revision.working_draft->'templateMatch'->>'templateVersion', '')::integer) AS template_version,
              COALESCE(revision.working_draft->'finalAssetOrder', '[]'::jsonb) AS final_asset_order,
              COALESCE(revision.working_draft->'warningCodes', '[]'::jsonb) AS warning_codes
       FROM products p
       JOIN LATERAL (
         SELECT * FROM product_revisions candidate WHERE candidate.product_id = p.id
         ORDER BY candidate.draft_version DESC, candidate.created_at DESC LIMIT 1
       ) revision ON true
       LEFT JOIN LATERAL (
         SELECT * FROM listing_drafts candidate WHERE candidate.revision_id = revision.id
         ORDER BY candidate.draft_version DESC, candidate.created_at DESC LIMIT 1
       ) listing ON true
       LEFT JOIN LATERAL (
         SELECT * FROM pricing_runs candidate WHERE candidate.revision_id = revision.id
         ORDER BY candidate.created_at DESC LIMIT 1
       ) pricing ON true
       LEFT JOIN LATERAL (
         SELECT * FROM canvas_runs candidate WHERE candidate.revision_id = revision.id
         ORDER BY candidate.created_at DESC LIMIT 1
       ) canvas ON true
       WHERE p.id = $1`,
      [productIdValue]
    );
    const row = result.rows[0];
    if (!row || typeof row.listing_run_id !== "string" ||
      !Number.isInteger(Number(row.template_version)) || Number(row.template_version) < 1) return null;
    const currency = requiredString(row, "currency") as MoneyCurrency;
    const priceMinor = optionalString(row, "final_price_minor");
    return {
      productId: productId(requiredString(row, "product_id")),
      draftVersion: Number(row.draft_version),
      listingRunId: row.listing_run_id,
      pricingRunId: typeof row.pricing_run_id === "string" ? row.pricing_run_id : null,
      templateVersion: Number(row.template_version),
      orderedFinalAssetIds: strings(row.final_asset_order).map(assetId),
      locale: requiredString(row, "locale"),
      currency,
      finalPriceWire: priceMinor ? { amountMinor: priceMinor, currency } : null,
      warningCodes: strings(row.warning_codes),
      miaoshouTargetDetailId: optionalString(row, "canonical_success_detail_id")
        ? miaoshouDetailId(optionalString(row, "canonical_success_detail_id")!)
        : null
    };
  }

  async facts(productIdValue: string): Promise<ReviewWorkspaceView["reviewFacts"]> {
    const result = await this.database.query(
      `SELECT revision.source_payload,
              COALESCE(revision.working_draft->'finalAssetOrder', '[]'::jsonb) AS final_asset_order,
              p.canonical_success_detail_id
       FROM products p
       JOIN LATERAL (
         SELECT * FROM product_revisions candidate WHERE candidate.product_id = p.id
         ORDER BY candidate.draft_version DESC, candidate.created_at DESC LIMIT 1
       ) revision ON true
       WHERE p.id = $1`, [productIdValue]
    );
    const row = result.rows[0];
    const source = row?.source_payload && typeof row.source_payload === "object"
      ? row.source_payload as Record<string, unknown>
      : {};
    const skus = Array.isArray(source.skus) ? source.skus : null;
    const skuStocks = skus?.map((sku) => sku && typeof sku === "object"
      ? integerEvidence((sku as Record<string, unknown>).stock)
      : null) ?? [];
    const stock = integerEvidence(source.sourceStock) ?? (skus && skus.length > 0 && skuStocks.every((value) => value !== null)
      ? skuStocks.reduce((total, value) => total + BigInt(value!), 0n).toString()
      : null);
    const order = strings(row?.final_asset_order);
    const assetResult = order.length === 0 ? { rows: [] } : await this.database.query(
      `SELECT id, remote_url, local_path FROM assets WHERE id = ANY($1::text[])`, [order]
    );
    const assets = new Map(assetResult.rows.map((asset) => [String(asset.id), asset]));
    const orderedFinalImages = order.flatMap((id) => {
      const asset = assets.get(id);
      if (!asset) return [];
      const remoteUrl = typeof asset.remote_url === "string" && /^https?:\/\//.test(asset.remote_url)
        ? asset.remote_url : null;
      const previewUrl = remoteUrl ?? (typeof asset.local_path === "string"
        ? `/api/v1/assets/${encodeURIComponent(id)}/content`
        : null);
      return previewUrl ? [{ assetId: id, previewUrl }] : [];
    });
    return {
      skuCount: skus ? skus.length : null,
      orderedFinalImages,
      stock,
      weightKg: decimalEvidence(source.weightKg),
      dimensions: dimensionEvidence(source.dimensionsCm),
      canonicalMiaoshouTarget: optionalString(row ?? {}, "canonical_success_detail_id")
    };
  }

  async assetLocalPath(assetIdValue: string): Promise<string | null> {
    const result = await this.database.query(
      `SELECT local_path FROM assets WHERE id = $1 AND state = 'ready' LIMIT 1`, [assetIdValue]
    );
    return optionalString(result.rows[0] ?? {}, "local_path");
  }
}
