import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { bootTestDb, type TestDbHandle } from "./runner.js";
import { CatalogRepository } from "../repositories/catalog-repository.js";
import { INITIAL_SQL } from "../migrations/0000_initial.js";

let handle: TestDbHandle;
let catalog: CatalogRepository;

beforeAll(async () => {
  handle = await bootTestDb();
  await handle.migrate(INITIAL_SQL);
  catalog = new CatalogRepository(handle.pool);
});

beforeEach(async () => {
  await handle.reset();
  await handle.migrate(INITIAL_SQL);
});

afterAll(async () => {
  await handle?.close();
});

describe("CatalogRepository - Slice 1: listProductPool", () => {
  test("returns projected product pool items with latest revision and state", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "test-operator",
      displayName: "Test Operator"
    });

    const productId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/123456.html",
      sourceItemId: "123456",
      locale: "th-TH",
      currency: "THB"
    });

    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "1688 Test Product",
      workingDraft: {
        warningCodes: ["sample_warning"]
      }
    });

    await handle.pool.query(
      `UPDATE product_revisions
       SET source_payload = $2::jsonb
       WHERE id = $1`,
      [
        revisionId,
        JSON.stringify({
          sourcePriceWire: { amountMinor: "1500", currency: "CNY" },
          mainImages: [{ url: "https://cbu01.alicdn.com/img/ibank/main1.jpg" }],
          detailImages: [{ url: "https://cbu01.alicdn.com/img/ibank/detail1.jpg" }],
          captureQuality: "detail_page_complete"
        })
      ]
    );

    // Act
    const items = await catalog.listProductPool();

    // Assert
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      productId,
      currentRevisionId: revisionId,
      sourceItemId: "123456",
      sourceUrl: "https://detail.1688.com/offer/123456.html",
      canonicalSourceTitle: "1688 Test Product",
      locale: "th-TH",
      currency: "THB",
      sourcePriceWire: { amountMinor: "1500", currency: "CNY" },
      sourceImageCount: 2,
      sourceCaptureQuality: "detail_page_complete",
      warningCodes: ["sample_warning"]
    });
    expect(items[0]?.originalImageUrls).toContain(
      "/api/v1/source-images?url=https%3A%2F%2Fcbu01.alicdn.com%2Fimg%2Fibank%2Fmain1.jpg"
    );
  });
});

describe("CatalogRepository - Slice 2: getProductWorkspace", () => {
  test("returns full product workspace projection with image generation slots", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "ws-operator",
      displayName: "Workspace Operator"
    });

    const productId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/789012.html",
      sourceItemId: "789012",
      locale: "th-TH",
      currency: "THB"
    });

    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "Workspace 1688 Title",
      workingDraft: {
        finalAssetOrder: ["asset_main_1"],
        warningCodes: ["warn_code_1"],
        templateMatchedReason: "rule_matched"
      }
    });

    await handle.pool.query(
      `UPDATE product_revisions
       SET source_payload = $2::jsonb
       WHERE id = $1`,
      [
        revisionId,
        JSON.stringify({
          description: "Source description",
          mainImages: ["https://cbu01.alicdn.com/img/ibank/m1.jpg"],
          detailImages: [],
          sourceAttributes: [{ name: "Material", value: "Cotton" }],
          saleAttributes: [{ name: "Color", value: "Red" }]
        })
      ]
    );

    // Insert listing draft
    await handle.pool.query(
      `INSERT INTO listing_drafts
        (id, product_id, revision_id, draft_version, target_locale, title, description, style, provider, model, fallback_used)
       VALUES
        ('ld_1', $1, $2, 1, 'th-TH', 'Target Title TH', 'Target Desc TH', 'clean', 'rules', 'test-model', false)`,
      [productId, revisionId]
    );

    // Insert pricing run
    await handle.pool.query(
      `INSERT INTO pricing_runs
        (id, product_id, revision_id, draft_version, final_currency, final_price_minor, breakdown)
       VALUES
        ('pr_1', $1, $2, 1, 'THB', '29900', '{"tax":"20"}'::jsonb)`,
      [productId, revisionId]
    );

    // Insert canvas run
    await handle.pool.query(
      `INSERT INTO canvas_runs
        (id, product_id, revision_id, template_id, template_version, outputs, state)
       VALUES
        ('cr_1', $1, $2, 'tpl_test', 2, '["asset_out_1"]'::jsonb, 'succeeded')`,
      [productId, revisionId]
    );



    // Insert available input asset
    await handle.pool.query(
      `INSERT INTO assets
        (id, product_id, revision_id, remote_url, kind, state, local_path, chosen_role)
       VALUES
        ('asset_main_1', $1, $2, 'https://cbu01.alicdn.com/img/ibank/m1.jpg', 'main', 'ready', '/data/assets/m1.jpg', 'primary')`,
      [productId, revisionId]
    );

    // Insert image generation template and version
    await handle.pool.query(
      `INSERT INTO image_generation_templates (id, name, category_key)
       VALUES ('tpl_img', 'Test Img Tpl', 'clothing')`
    );
    await handle.pool.query(
      `INSERT INTO image_generation_template_versions (id, template_id, version, lifecycle_state, recipe)
       VALUES ('tpl_v1', 'tpl_img', 1, 'active', '{}'::jsonb)`
    );

    // Insert image generation batch
    const batchId = "batch_ig_1";
    await handle.pool.query(
      `INSERT INTO image_generation_batches
        (id, product_id, revision_id, idempotency_key, selected_asset_ids, requested_output_count, category_key, template_id, template_version_id, template_version, recipe_snapshot, product_facts_snapshot, product_facts_digest, state)
       VALUES
        ($1, $2, $3, 'idemp_1', '["asset_main_1"]'::jsonb, 1, 'clothing', 'tpl_img', 'tpl_v1', 1, '{}'::jsonb, '{}'::jsonb, 'digest', 'succeeded')`,
      [batchId, productId, revisionId]
    );


    // Insert image generation slot with generated asset
    await handle.pool.query(
      `INSERT INTO assets
        (id, product_id, revision_id, remote_url, kind, state, local_path)
       VALUES
        ('asset_gen_1', $1, $2, 'https://gen.local/1.jpg', 'generated', 'ready', '/data/assets/gen1.jpg')`,
      [productId, revisionId]
    );

    await handle.pool.query(
      `INSERT INTO image_generation_slots
        (id, batch_id, slot_number, role, state, attempt, archived_asset_id)
       VALUES
        ('slot_1', $1, 1, 'primary', 'succeeded', 1, 'asset_gen_1')`,
      [batchId]
    );

    // Act
    const workspace = await catalog.getProductWorkspace(productId);

    // Assert
    expect(workspace).not.toBeNull();
    expect(workspace).toMatchObject({
      productId,
      revisionId,
      draftVersion: 1,
      originalListing: {
        sourceTitle: "Workspace 1688 Title",
        description: "Source description",
        sourceAttributes: [{ name: "Material", value: "Cotton" }],
        saleAttributes: [{ name: "Color", value: "Red" }],
        mainImages: ["https://cbu01.alicdn.com/img/ibank/m1.jpg"]
      },
      target: {
        locale: "th-TH",
        title: "Target Title TH",
        description: "Target Desc TH",
        style: "clean",
        provider: "rules",
        model: "test-model",
        fallbackUsed: false
      },
      pricing: {
        pricingRunId: "pr_1",
        currency: "THB",
        finalPriceWire: { amountMinor: "29900", currency: "THB" }
      },
      template: {
        templateId: "tpl_test",
        version: 2,
        matchedReason: "rule_matched"
      },
      canvas: {
        runId: "cr_1",
        outputs: ["asset_out_1"],
        state: "succeeded"
      },
      imageGeneration: {
        batchId,
        requestedCount: 1,
        successfulCount: 1,
        state: "succeeded",
        availableInputs: [
          { assetId: "asset_main_1", localUrl: "/api/v1/assets/asset_main_1/content", role: "primary" }
        ],
        selectedInputs: [
          { assetId: "asset_main_1", localUrl: "/api/v1/assets/asset_main_1/content" }
        ],
        slots: [
          {
            slotId: "slot_1",
            slotNumber: 1,
            role: "primary",
            status: "succeeded",
            localUrl: "/api/v1/assets/asset_gen_1/content"
          }
        ]
      },
      finalAssetOrder: ["asset_main_1"],
      warningCodes: ["warn_code_1"]
    });

    const nonExistent = await catalog.getProductWorkspace("prod_non_existent");
    expect(nonExistent).toBeNull();
  });
});

describe("CatalogRepository - Slice 3: getApprovalPreview", () => {
  test("returns approval preview projection with approval snapshot and miaoshou sync", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "preview-operator",
      displayName: "Preview Operator"
    });

    const productId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/345678.html",
      sourceItemId: "345678",
      locale: "th-TH",
      currency: "THB"
    });

    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "Preview 1688 Title",
      workingDraft: {
        finalAssetOrder: ["asset_appr_1"],
        warningCodes: ["preview_warn_1"]
      }
    });

    // Listing draft
    await handle.pool.query(
      `INSERT INTO listing_drafts
        (id, product_id, revision_id, draft_version, target_locale, title, description, style, provider, model, fallback_used)
       VALUES
        ('ld_preview_1', $1, $2, 1, 'th-TH', 'Title TH', 'Desc TH', 'clean', 'rules', 'model', false)`,
      [productId, revisionId]
    );

    // Pricing run
    await handle.pool.query(
      `INSERT INTO pricing_runs
        (id, product_id, revision_id, draft_version, final_currency, final_price_minor, breakdown)
       VALUES
        ('pr_preview_1', $1, $2, 1, 'THB', '19900', '{}'::jsonb)`,
      [productId, revisionId]
    );

    // Canvas run with template_version = 3
    await handle.pool.query(
      `INSERT INTO canvas_runs
        (id, product_id, revision_id, template_id, template_version, outputs, state)
       VALUES
        ('cr_preview_1', $1, $2, 'tpl_p', 3, '[]'::jsonb, 'succeeded')`,
      [productId, revisionId]
    );

    // Approval snapshot
    const approvalId = "appr_snap_1";
    await handle.pool.query(
      `INSERT INTO approval_snapshots
        (id, product_id, revision_id, draft_version, listing_run_id, pricing_run_id, template_version,
         source_canonical_url, source_item_id, locale, currency, title, description, state)
       VALUES
        ($1, $2, $3, 1, 'ld_preview_1', 'pr_preview_1', 3,
         'https://detail.1688.com/offer/345678.html', '345678', 'th-TH', 'THB', 'Title TH', 'Desc TH', 'approved')`,
      [approvalId, productId, revisionId]
    );

    // Miaoshou sync
    await handle.pool.query(
      `INSERT INTO miaoshou_syncs
        (id, approval_snapshot_id, state)
       VALUES
        ('sync_1', $1, 'syncing')`,
      [approvalId]
    );

    // Act
    const preview = await catalog.getApprovalPreview(productId);

    // Assert
    expect(preview).not.toBeNull();
    expect(preview).toMatchObject({
      productId,
      draftVersion: 1,
      listingRunId: "ld_preview_1",
      pricingRunId: "pr_preview_1",
      templateVersion: 3,
      orderedFinalAssetIds: ["asset_appr_1"],
      locale: "th-TH",
      currency: "THB",
      finalPriceWire: { amountMinor: "19900", currency: "THB" },
      warningCodes: ["preview_warn_1"],
      miaoshouWriteback: {
        state: "syncing",
        retryAllowed: false,
        approvalSnapshotId: approvalId
      }
    });

    // Missing listing run should return null
    const noListingProdId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/999999.html",
      locale: "th-TH",
      currency: "THB"
    });
    await catalog.insertRevision({
      productId: noListingProdId,
      draftVersion: 1,
      sourceTitle: "No Listing",
      workingDraft: {}
    });

    const emptyPreview = await catalog.getApprovalPreview(noListingProdId);
    expect(emptyPreview).toBeNull();
  });
});

describe("CatalogRepository - Slice 4: getProductFacts & getAssetLocalPath", () => {
  test("returns product facts calculation and resolves ready asset local path", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "facts-operator",
      displayName: "Facts Operator"
    });

    const productId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/555666.html",
      sourceItemId: "555666",
      locale: "th-TH",
      currency: "THB"
    });

    await handle.pool.query(
      `UPDATE products
       SET canonical_success_detail_id = 'ms_detail_99'
       WHERE id = $1`,
      [productId]
    );

    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "Facts 1688 Title",
      workingDraft: {
        finalAssetOrder: ["asset_fact_1"]
      }
    });

    await handle.pool.query(
      `UPDATE product_revisions
       SET source_payload = $2::jsonb
       WHERE id = $1`,
      [
        revisionId,
        JSON.stringify({
          skus: [
            { skuId: "sku_1", stock: 10 },
            { skuId: "sku_2", stock: 25 }
          ],
          weightKg: "0.45",
          dimensionsCm: {
            lengthCm: "10.5",
            widthCm: "8.2",
            heightCm: "2.1"
          }
        })
      ]
    );

    // Insert asset ready with local_path
    await handle.pool.query(
      `INSERT INTO assets
        (id, product_id, revision_id, remote_url, kind, state, local_path)
       VALUES
        ('asset_fact_1', $1, $2, 'https://cdn.example.test/img1.jpg', 'main', 'ready', '/data/assets/f1.jpg'),
        ('asset_fact_2', $1, $2, 'https://cdn.example.test/img2.jpg', 'main', 'pending', '/data/assets/f2.jpg')`,
      [productId, revisionId]
    );

    // Act
    const facts = await catalog.getProductFacts(productId);
    const readyPath = await catalog.getAssetLocalPath("asset_fact_1");
    const pendingPath = await catalog.getAssetLocalPath("asset_fact_2");

    // Assert
    expect(facts).toEqual({
      skuCount: 2,
      orderedFinalImages: [
        {
          assetId: "asset_fact_1",
          previewUrl: "/api/v1/assets/asset_fact_1/content",
          thumbnailUrl: "/api/v1/assets/asset_fact_1/content?variant=thumbnail"
        }
      ],
      stock: "35",
      weightKg: "0.45",
      dimensions: {
        lengthCm: "10.5",
        widthCm: "8.2",
        heightCm: "2.1"
      },
      canonicalMiaoshouTarget: "ms_detail_99"
    });

    expect(readyPath).toBe("/data/assets/f1.jpg");
    expect(pendingPath).toBeNull();
  });
});





