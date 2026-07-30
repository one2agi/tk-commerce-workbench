import { strict as assert } from "node:assert";

import type { IngestLocalCaptureItemV3 } from "@tk/contracts/commands";

import { schema, type DbPool } from "../schema/index.js";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export class LocalCaptureRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly operatorHandle = "local-operator"
  ) {}

  async save(input: {
    batchId: string;
    item: IngestLocalCaptureItemV3;
  }): Promise<{
    sourceItemId: string;
    productId: string;
    revisionId: string;
    created: boolean;
  }> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `INSERT INTO ${schema.localOperators} (id, handle, display_name)
         VALUES ($1, $2, 'Local Operator')
         ON CONFLICT (handle) DO NOTHING`,
        [newId("op"), this.operatorHandle]
      );
      const operator = await client.query<{ id: string }>(
        `SELECT id FROM ${schema.localOperators} WHERE handle = $1`,
        [this.operatorHandle]
      );
      assert(operator.rows[0], "local operator must exist");

      const candidateProductId = newId("prod");
      const insertedProduct = await client.query<{ id: string }>(
        `INSERT INTO ${schema.products}
          (id, operator_id, source_url, source_item_id, locale, currency,
           state_source, state_automation)
         VALUES ($1, $2, $3, $4, 'th-TH', 'THB', 'local_captured', 'not_started')
         ON CONFLICT (operator_id, source_item_id) WHERE source_item_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [candidateProductId, operator.rows[0].id, input.item.sourceUrl, input.item.sourceItemId]
      );
      const productWasCreated = (insertedProduct.rowCount ?? 0) > 0;
      const product = productWasCreated
        ? insertedProduct
        : await client.query<{ id: string }>(
            `SELECT id FROM ${schema.products}
             WHERE operator_id = $1 AND source_item_id = $2
             FOR UPDATE`,
            [operator.rows[0].id, input.item.sourceItemId]
          );
      assert(product.rows[0], "local capture product must exist");
      const productId = product.rows[0].id;

      const existingRevision = await client.query<{ id: string }>(
        `SELECT id FROM ${schema.productRevisions}
         WHERE product_id = $1
           AND source_payload->>'captureIdempotencyKey' = $2
         ORDER BY draft_version DESC
         LIMIT 1`,
        [productId, input.item.idempotencyKey]
      );
      if (existingRevision.rows[0]) {
        await client.query("COMMIT");
        return {
          sourceItemId: input.item.sourceItemId,
          productId,
          revisionId: existingRevision.rows[0].id,
          created: false
        };
      }

      const version = await client.query<{ next_version: number }>(
        `SELECT COALESCE(MAX(draft_version), 0) + 1 AS next_version
         FROM ${schema.productRevisions}
         WHERE product_id = $1`,
        [productId]
      );
      const revisionId = newId("rev");
      const toImagePayload = (url: string) => ({ url, width: 0, height: 0 });
      const sourcePayload = {
        sourceItemId: input.item.sourceItemId,
        sourceUrl: input.item.sourceUrl,
        title: input.item.title,
        description: input.item.descriptionText ?? "",
        itemNumber: input.item.itemNumber,
        category: input.item.category,
        sourcePriceWire: input.item.sourcePriceWire,
        sourcePriceRangeWire: input.item.sourcePriceRangeWire,
        sourceStock: input.item.sourceStock,
        weightKg: input.item.weightKg,
        dimensionsCm: input.item.dimensionsCm,
        mainImages: input.item.mainImages.map(toImagePayload),
        detailImages: input.item.detailImages.map(toImagePayload),
        sourceAttributes: input.item.attributes ?? [],
        saleAttributes: input.item.saleAttributes,
        skuAttributes: input.item.skuAttributes ?? [],
        skuText: input.item.skuText ?? [],
        colors: input.item.colors,
        sizes: input.item.sizes,
        skus: input.item.skus,
        capturedAt: input.item.capturedAt,
        captureQuality: input.item.captureQuality,
        captureDiagnostics: input.item.diagnostics,
        captureBatchId: input.batchId,
        captureIdempotencyKey: input.item.idempotencyKey
      };
      const workingDraft = {
        sourceLocale: "zh-CN",
        targetLocale: "th-TH",
        style: "marketplace"
      };
      await client.query(
        `INSERT INTO ${schema.productRevisions}
          (id, product_id, draft_version, source_title, source_payload, working_draft)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          revisionId,
          productId,
          Number(version.rows[0]?.next_version ?? 1),
          input.item.title,
          JSON.stringify(sourcePayload),
          JSON.stringify(workingDraft)
        ]
      );
      await client.query(
        `UPDATE ${schema.products}
         SET source_url = $2,
             state_source = 'local_captured',
             state_automation = 'not_started',
             state_asset_archive = 'pending',
             state_listing = 'pending',
             state_canvas = 'not_started',
             state_approval = 'unapproved',
             state_miaoshou_edit = 'not_started',
             updated_at = now()
         WHERE id = $1`,
        [productId, input.item.sourceUrl]
      );
      await client.query("COMMIT");
      return {
        sourceItemId: input.item.sourceItemId,
        productId,
        revisionId,
        created: productWasCreated
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}
