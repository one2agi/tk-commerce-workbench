// Integration test for repositories.
//
// Scenarios:
//  - migrate empty Postgres
//  - upsert fixed local operator
//  - insert one product with two revisions (revision #2 must NOT overwrite revision #1)
//  - claim a job, second claim with same owner+now+lease returns ONE job
//  - exchange_rate_snapshots records source/observedAt/manual override provenance

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";

import type { ConfirmMiaoshouEditV1 } from "@tk/contracts";

import { bootTestDb, type TestDbHandle } from "./runner.js";
import { CatalogRepository } from "../repositories/catalog-repository.js";
import { createMiaoshouReconciliationContext, JobRepository } from "../repositories/job-repository.js";
import { ExchangeRateRepository } from "../repositories/exchange-rate-repository.js";
import { AutomationRunRepository } from "../repositories/automation-run-repository.js";
import { CanvasQuotaRepository } from "../repositories/canvas-quota-repository.js";
import { AssetRepository } from "../repositories/asset-repository.js";
import { PipelineRepository } from "../repositories/pipeline-repository.js";
import { LocalCaptureRepository } from "../repositories/local-capture-repository.js";
import { ApprovalRepository } from "../repositories/approval-repository.js";
import { ImageGenerationRepository } from "../repositories/image-generation-repository.js";
import { INITIAL_SQL } from "../migrations/0000_initial.js";

function newId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

let handle: TestDbHandle;
let catalog: CatalogRepository;
let jobs: JobRepository;
let rates: ExchangeRateRepository;
let automations: AutomationRunRepository;
let approvals: ApprovalRepository;
let canvasQuota: CanvasQuotaRepository;
let assets: AssetRepository;
let pipeline: PipelineRepository;
let localCaptures: LocalCaptureRepository;
let imageGen: ImageGenerationRepository;

beforeAll(async () => {
  handle = await bootTestDb();
  await handle.migrate(INITIAL_SQL);
  catalog = new CatalogRepository(handle.pool);
  jobs = new JobRepository(handle.pool);
  rates = new ExchangeRateRepository(handle.pool);
  automations = new AutomationRunRepository(handle.pool);
  approvals = new ApprovalRepository(handle.pool);
  canvasQuota = new CanvasQuotaRepository(handle.pool);
  assets = new AssetRepository(handle.pool);
  pipeline = new PipelineRepository(handle.pool);
  localCaptures = new LocalCaptureRepository(handle.pool);
  imageGen = new ImageGenerationRepository(handle.pool);
});

beforeEach(async () => {
  await handle.reset();
  await handle.migrate(INITIAL_SQL);
});

afterAll(async () => {
  await handle?.close();
});

describe("integration: bootstrap", () => {
  test("migration is idempotent — second run is a no-op", async () => {
    await handle.migrate(INITIAL_SQL);
    // Schema must still exist with the same tables.
    const result = await handle.pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    const names = result.rows.map((r) => r.table_name).sort();
    expect(names).toContain("products");
    expect(names).toContain("product_revisions");
    expect(names).toContain("jobs");
    expect(names).toContain("exchange_rate_snapshots");
    expect(names).toContain("automation_runs");
    expect(names).toContain("runtime_configuration_status");
  });

  test("upgrades legacy settings and templates without overwriting saved values", async () => {
    await handle.pool.query("DROP TABLE templates, workspace_settings");
    await handle.pool.query(`
      CREATE TABLE templates (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, category_rules JSONB NOT NULL DEFAULT '[]',
        reference_asset_ids JSONB NOT NULL DEFAULT '[]', prompt_fragment TEXT NOT NULL DEFAULT '',
        target_locale TEXT NOT NULL, visual_style TEXT NOT NULL DEFAULT '', enabled BOOLEAN NOT NULL DEFAULT true,
        version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
      );
      CREATE TABLE workspace_settings (
        id INTEGER PRIMARY KEY, default_locale TEXT NOT NULL DEFAULT 'th-TH',
        default_currency TEXT NOT NULL DEFAULT 'THB', external_adapter_mode TEXT NOT NULL DEFAULT 'mock',
        miaoshou_configured BOOLEAN NOT NULL DEFAULT false, canvas_configured BOOLEAN NOT NULL DEFAULT false,
        llm_configured BOOLEAN NOT NULL DEFAULT false, exchange_rate_configured BOOLEAN NOT NULL DEFAULT false,
        worker_concurrency INTEGER NOT NULL DEFAULT 1, max_canvas_runs_per_day INTEGER NOT NULL DEFAULT 50,
        asset_root TEXT NOT NULL DEFAULT './var/assets'
      );
      INSERT INTO templates (id, name, target_locale, prompt_fragment)
        VALUES ('legacy-template', 'Legacy TK', 'th-TH', 'keep me');
      INSERT INTO workspace_settings (id, default_locale, worker_concurrency, asset_root)
        VALUES (1, 'vi-VN', 7, './legacy-assets');
    `);

    await handle.migrate(INITIAL_SQL);
    await handle.migrate(INITIAL_SQL);

    const template = await handle.pool.query(
      "SELECT id, template_key, prompt_fragment, version FROM templates WHERE id = 'legacy-template'"
    );
    expect(template.rows[0]).toEqual({
      id: "legacy-template", template_key: "legacy-template", prompt_fragment: "keep me", version: 1
    });
    const settings = await handle.pool.query(
      `SELECT default_locale, worker_concurrency, asset_root, version,
              pricing_defaults, provider_options, retry_policy,
              service_configuration, encrypted_secrets
       FROM workspace_settings WHERE id = 1`
    );
    expect(settings.rows[0]).toMatchObject({
      default_locale: "vi-VN", worker_concurrency: 7, asset_root: "./legacy-assets", version: "1",
      pricing_defaults: { targetProfitRate: "0.30" },
      provider_options: { canvasWorkflow: "TK工作流" },
      retry_policy: { maxAttempts: 3 },
      service_configuration: {},
      encrypted_secrets: null
    });
  });

  test("template matching sees only the latest enabled version of each template family", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "template-match", displayName: "Template Match" });
    const productId = await catalog.insertProduct({
      operatorId, sourceUrl: "https://detail.1688.com/offer/template.html", locale: "th-TH", currency: "THB"
    });
    const revisionId = await catalog.insertRevision({
      productId, draftVersion: 1, sourceTitle: "Dress", workingDraft: {}
    });
    await handle.pool.query(
      `INSERT INTO templates
        (id, template_key, name, category_rules, target_locale, enabled, version)
       VALUES
        ('family-a-v1', 'family-a', 'Old A', '[{"categoryKey":"old","priority":1}]', 'th-TH', true, 1),
        ('family-a-v2', 'family-a', 'Current A', '[{"categoryKey":"dress","priority":10}]', 'th-TH', true, 2),
        ('family-b-v1', 'family-b', 'Old B', '[]', 'th-TH', true, 1),
        ('family-b-v2', 'family-b', 'Disabled B', '[]', 'th-TH', false, 2)`
    );

    const inputs = await pipeline.loadMatchInputs(revisionId);
    expect(inputs.templates).toHaveLength(1);
    expect(inputs.templates[0]).toMatchObject({
      id: "family-a", enabled: true,
      rules: [{ category: "dress", priority: 10 }], version: 2
    });
    expect(inputs.defaultTemplateId).toBe("family-a");
  });

  test("loadPlan fails closed when any immutable template reference is not ready locally", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "template-refs", displayName: "Template Refs" });
    const productId = await catalog.insertProduct({
      operatorId, sourceUrl: "https://detail.1688.com/offer/refs.html", locale: "th-TH", currency: "THB"
    });
    const revisionId = await catalog.insertRevision({
      productId, draftVersion: 1, sourceTitle: "Refs",
      workingDraft: {
        templateMatch: { templateId: "template-refs", templateVersion: 1 },
        imageSelection: { assetIds: [] }
      }
    });
    await handle.pool.query(
      `INSERT INTO templates
        (id, template_key, name, reference_asset_ids, target_locale, enabled, version)
       VALUES ('template-refs-v1', 'template-refs', 'Refs',
               '["ref-ready","ref-missing","ref-rejected","ref-no-local"]', 'th-TH', true, 1)`
    );
    await handle.pool.query(
      `INSERT INTO assets
        (id, product_id, revision_id, remote_url, kind, state, local_path, rejection_reason)
       VALUES
        ('ref-ready', $1, $2, 'local:ready', 'reference', 'ready', '/assets/ready.png', NULL),
        ('ref-rejected', $1, $2, 'local:rejected', 'reference', 'rejected', '/assets/rejected.png', 'watermark'),
        ('ref-no-local', $1, $2, 'local:no-local', 'reference', 'ready', NULL, NULL)`,
      [productId, revisionId]
    );

    await expect(pipeline.loadPlan(revisionId)).rejects.toMatchObject({
      code: "template_reference_unavailable"
    });
  });

  test("upgrades duplicate product identities and legacy detail_id without data loss or canonical guessing", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "legacy-operator",
      displayName: "Legacy Operator"
    });
    await handle.pool.query("DROP INDEX products_operator_source_item_unique");
    await handle.pool.query("ALTER TABLE miaoshou_source_records ADD COLUMN detail_id TEXT");
    await handle.pool.query(
      `INSERT INTO products
        (id, operator_id, source_url, source_item_id, canonical_success_detail_id)
       VALUES
        ('prod-legacy-a', $1, 'https://detail.1688.com/offer/legacy-a.html', 'legacy-1', NULL),
        ('prod-legacy-b', $1, 'https://detail.1688.com/offer/legacy-b.html', 'legacy-1', 'known-canonical')`,
      [operatorId]
    );
    await handle.pool.query(
      `INSERT INTO product_revisions (id, product_id, draft_version, source_payload, working_draft)
       VALUES
        ('rev-legacy-a', 'prod-legacy-a', 1, '{}'::jsonb, '{}'::jsonb),
        ('rev-legacy-b', 'prod-legacy-b', 1, '{}'::jsonb, '{}'::jsonb)`
    );
    await handle.pool.query(
      `INSERT INTO miaoshou_source_records
        (id, product_id, source_item_id, detail_id, fetch_detail_id,
         canonical_success_detail_id, fetched_payload)
       VALUES ('source-legacy', 'prod-legacy-a', 'legacy-1', 'legacy-detail', NULL, NULL, '{}'::jsonb)`
    );

    await handle.migrate(INITIAL_SQL);

    const products = await handle.pool.query(
      `SELECT id, source_url, source_item_id, canonical_success_detail_id
       FROM products WHERE id IN ('prod-legacy-a', 'prod-legacy-b') ORDER BY id`
    );
    expect(products.rows).toEqual([
      {
        id: "prod-legacy-a",
        source_url: "https://detail.1688.com/offer/legacy-a.html",
        source_item_id: null,
        canonical_success_detail_id: null
      },
      {
        id: "prod-legacy-b",
        source_url: "https://detail.1688.com/offer/legacy-b.html",
        source_item_id: "legacy-1",
        canonical_success_detail_id: "known-canonical"
      }
    ]);
    const revisions = await handle.pool.query(
      "SELECT id FROM product_revisions WHERE id IN ('rev-legacy-a', 'rev-legacy-b') ORDER BY id"
    );
    expect(revisions.rows.map((row) => row.id)).toEqual(["rev-legacy-a", "rev-legacy-b"]);
    const source = await handle.pool.query(
      `SELECT fetch_detail_id, canonical_success_detail_id, failure_reason
       FROM miaoshou_source_records WHERE id = 'source-legacy'`
    );
    expect(source.rows[0]).toEqual({
      fetch_detail_id: "legacy-detail",
      canonical_success_detail_id: null,
      failure_reason: "legacy_detail_id_requires_reparse"
    });
  });
});

describe("integration: catalog repository", () => {
  test("persists a local detail capture idempotently without a Miaoshou source record", async () => {
    const item = {
      sourceItemId: "892408514788",
      sourceUrl: "https://detail.1688.com/offer/892408514788.html",
      title: "测试商品",
      mainImages: ["https://cbu01.alicdn.com/img/ibank/main.jpg"],
      detailImages: ["https://cbu01.alicdn.com/img/ibank/detail.jpg"],
      descriptionText: "商品详情正文",
      itemNumber: "ITEM-892408514788",
      category: "饰品 > 手表",
      sourcePriceWire: { amountMinor: "1350", currency: "CNY" as const },
      sourcePriceRangeWire: {
        minAmountMinor: "1350",
        maxAmountMinor: "1420",
        currency: "CNY" as const
      },
      sourceStock: 159,
      weightKg: "0.12",
      dimensionsCm: { lengthCm: "15", widthCm: "15", heightCm: "3" },
      attributes: [{ name: "材质", value: "不锈钢" }],
      saleAttributes: [{ name: "颜色", value: "银色" }],
      skuAttributes: [{ name: "颜色", values: [{ name: "银色" }] }],
      skuText: ["颜色: 银色"],
      colors: ["银色"],
      sizes: [],
      skus: [{
        skuId: "sku-silver",
        attributes: { 颜色: "银色" },
        priceWire: { amountMinor: "1350", currency: "CNY" as const },
        stock: 159,
        imageUrl: null,
        weightKg: "0.08"
      }],
      capturedAt: "2026-07-24T08:00:00.000Z",
      captureQuality: "detail_page_complete" as const,
      diagnostics: {
        version: 2 as const,
        pageKind: "offer_detail" as const,
        titleSource: "page_context" as const,
        stableForMs: 2000,
        fieldEvidence: {
          title: "captured" as const,
          mainImages: "captured" as const,
          detail: "captured" as const,
          attributes: "captured" as const,
          price: "captured" as const,
          stock: "captured" as const,
          skus: "captured" as const,
          weight: "captured" as const,
          dimensions: "captured" as const
        },
        expectedSkuCount: 1,
        capturedSkuCount: 1,
        acceptedMainImages: 1,
        acceptedDetailImages: 1,
        rejectedImages: 0,
        warnings: []
      },
      idempotencyKey: "1688:892408514788:batch_local_01"
    };

    const first = await localCaptures.save({ batchId: "batch_local_01", item });
    const repeated = await localCaptures.save({ batchId: "batch_local_01", item });

    expect(first).toMatchObject({ sourceItemId: item.sourceItemId, created: true });
    expect(repeated).toEqual({ ...first, created: false });
    const product = await handle.pool.query(
      `SELECT state_source, state_automation, canonical_success_detail_id
       FROM products WHERE id = $1`,
      [first.productId]
    );
    expect(product.rows[0]).toEqual({
      state_source: "local_captured",
      state_automation: "not_started",
      canonical_success_detail_id: null
    });
    const revision = await handle.pool.query(
      `SELECT source_title, source_payload, working_draft
       FROM product_revisions WHERE id = $1`,
      [first.revisionId]
    );
    expect(revision.rows[0]).toMatchObject({
      source_title: item.title,
      source_payload: {
        sourceItemId: item.sourceItemId,
        title: item.title,
        sourceAttributes: item.attributes,
        saleAttributes: item.saleAttributes,
        skuAttributes: item.skuAttributes,
        skuText: item.skuText,
        sourcePriceWire: item.sourcePriceWire,
        sourcePriceRangeWire: item.sourcePriceRangeWire,
        sourceStock: item.sourceStock,
        itemNumber: item.itemNumber,
        category: item.category,
        weightKg: item.weightKg,
        dimensionsCm: item.dimensionsCm,
        colors: item.colors,
        sizes: item.sizes,
        skus: item.skus,
        description: item.descriptionText,
        captureQuality: "detail_page_complete",
        captureDiagnostics: item.diagnostics,
        captureIdempotencyKey: item.idempotencyKey
      },
      working_draft: {
        sourceLocale: "zh-CN",
        targetLocale: "th-TH"
      }
    });
    expect(revision.rows[0].source_payload.mainImages[0]).toMatchObject({
      url: item.mainImages[0]
    });
    const sourceRecords = await handle.pool.query(
      "SELECT count(*)::integer AS count FROM miaoshou_source_records WHERE product_id = $1",
      [first.productId]
    );
    expect(sourceRecords.rows[0]?.count).toBe(0);
  });

  test("upserts the fixed local operator", async () => {
    const id = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    expect(id).toMatch(/^op_/);
    // Calling again returns the same id.
    const id2 = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    expect(id2).toBe(id);
  });

  test("inserts product with two revisions without overwriting", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });

    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/123.html",
      locale: "th-TH",
      currency: "THB"
    });

    const revA = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "v1 title",
      workingDraft: { foo: "bar" }
    });
    const revB = await catalog.insertRevision({
      productId,
      draftVersion: 2,
      sourceTitle: "v2 title",
      workingDraft: { foo: "baz" }
    });

    expect(revA).not.toBe(revB);
    const all = await catalog.listRevisions(productId);
    expect(all).toHaveLength(2);
    // Both revisions preserved (no overwrite).
    expect(all.map((r) => r.sourceTitle).sort()).toEqual(["v1 title", "v2 title"]);
  });

  test("reuses product identity for the same operator and source item", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const first = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/123.html",
      sourceItemId: "123",
      locale: "th-TH",
      currency: "THB"
    });
    const second = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/123.html?spm=repeat",
      sourceItemId: "123",
      locale: "th-TH",
      currency: "THB"
    });
    expect(second).toBe(first);
    const count = await handle.pool.query(
      "SELECT count(*)::int AS count FROM products WHERE operator_id = $1 AND source_item_id = '123'",
      [operatorId]
    );
    expect(count.rows[0].count).toBe(1);
  });
});

describe("integration: asset repository", () => {
  test("deduplicates a remote asset and persists archive plus quality evidence", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "asset-operator", displayName: "Asset Operator" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/asset.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "asset", workingDraft: {} });
    const input = { productId, revisionId, remoteUrl: "https://cdn.example.test/product.jpg", kind: "main" as const, width: 1200, height: 1200 };
    const first = await assets.upsert(input);
    const second = await assets.upsert(input);
    expect(second).toBe(first);

    await assets.recordProcessed({
      assetId: first,
      sha256: "abc123",
      localPath: "/data/assets/ab/abc123.jpg",
      extension: "jpg",
      perceptualHash: "phash-1",
      clarity: 0.91,
      duplicateDistance: 8,
      watermarkProbability: 0.03,
      collageProbability: 0.04,
      nonProductProbability: 0.02,
      visualScore: 0.88,
      chosenRole: "primary",
      rejectionReason: null
    });

    const stored = await handle.pool.query("SELECT * FROM assets WHERE product_id = $1 AND remote_url = $2", [productId, input.remoteUrl]);
    expect(stored.rows).toHaveLength(1);
    expect(stored.rows[0]).toMatchObject({
      state: "ready",
      sha256: "abc123",
      local_path: "/data/assets/ab/abc123.jpg",
      extension: "jpg",
      perceptual_hash: "phash-1",
      chosen_role: "primary",
      rejection_reason: null
    });
  });

  test("keeps the same remote URL independently attached to two immutable revisions", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "immutable-assets", displayName: "Immutable Assets" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/immutable.html", locale: "th-TH", currency: "THB" });
    const firstRevision = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "one", workingDraft: {} });
    const secondRevision = await catalog.insertRevision({ productId, draftVersion: 2, sourceTitle: "two", workingDraft: {} });
    const remoteUrl = "https://cdn.example.test/shared.jpg";
    const first = await assets.upsert({ productId, revisionId: firstRevision, remoteUrl, kind: "main" });
    const second = await assets.upsert({ productId, revisionId: secondRevision, remoteUrl, kind: "main" });
    expect(second).not.toBe(first);
    const rows = await handle.pool.query("SELECT revision_id FROM assets WHERE product_id = $1 AND remote_url = $2 ORDER BY revision_id", [productId, remoteUrl]);
    expect(rows.rows.map((row) => row.revision_id)).toEqual([firstRevision, secondRevision].sort());
  });
});

describe("integration: durable pipeline repository", () => {
  const collectedDetail = {
    detailId: "detail-canonical", sourceItemId: "source-canonical" as never, sourceUrl: "https://detail.1688.com/offer/canonical.html",
    title: "Canonical", itemNumber: null, description: "Description", category: null,
    sourcePriceWire: { amountMinor: "1000", currency: "CNY" as const }, sourceStock: 1, weightKg: "0.3", dimensionsCm: null,
    mainImages: [], detailImages: [], sourceAttributes: [], saleAttributes: [], colors: [], sizes: [], skus: []
  };

  test("reuses one canonical revision across first-success and duplicate-skip collection attempts", async () => {
    const firstJob = await jobs.enqueue({ kind: "miaoshou_collect", businessKey: "canonical:first", payload: { version: 1 } });
    const firstClaim = await jobs.claim("worker-first", new Date(), 30_000);
    const first = await pipeline.saveCollected({
      batchId: "batch-first", sourceUrl: collectedDetail.sourceUrl,
      result: { fetchDetailId: "fetch-first", skippedDetailId: null, canonicalSuccessDetailId: "detail-canonical", detail: collectedDetail }
    }, { jobId: firstJob, owner: "worker-first", leaseToken: firstClaim!.leaseToken });
    await jobs.complete(firstJob, "worker-first", firstClaim!.leaseToken, new Date());

    const duplicateJob = await jobs.enqueue({ kind: "miaoshou_collect", businessKey: "canonical:duplicate", payload: { version: 1 } });
    const duplicateClaim = await jobs.claim("worker-duplicate", new Date(), 30_000);
    const duplicate = await pipeline.saveCollected({
      batchId: "batch-duplicate", sourceUrl: collectedDetail.sourceUrl,
      result: { fetchDetailId: null, skippedDetailId: "skip-duplicate", canonicalSuccessDetailId: "detail-canonical", detail: collectedDetail }
    }, { jobId: duplicateJob, owner: "worker-duplicate", leaseToken: duplicateClaim!.leaseToken });

    expect(duplicate?.revisionId).toBe(first?.revisionId);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM products WHERE source_item_id = 'source-canonical'")).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM product_revisions WHERE product_id = (SELECT id FROM products WHERE source_item_id = 'source-canonical')")).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM miaoshou_source_records WHERE source_item_id = 'source-canonical'")).rows[0]?.count)).toBe(2);
    const sourceStates = await handle.pool.query("SELECT state FROM miaoshou_source_records WHERE source_item_id = 'source-canonical' ORDER BY created_at, id");
    expect(sourceStates.rows.map((row) => row.state).sort()).toEqual(["skipped_duplicate", "success"]);
    const productState = await handle.pool.query("SELECT state_source FROM products WHERE source_item_id = 'source-canonical'");
    expect(productState.rows[0]?.state_source).toBe("success");
  });

  test("reuses listing, pricing and Canvas result rows after write-before-complete recovery", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "durable-results", displayName: "Durable Results" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/durable.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "durable", workingDraft: {} });
    const invokeTwice = async (kind: string, write: (fence: { jobId: string; owner: string; leaseToken: string }) => Promise<boolean>) => {
      for (const suffix of ["first", "restart"]) {
        const id = await jobs.enqueue({ kind, businessKey: `${kind}:${suffix}`, payload: { version: 1, revisionId } });
        const claim = await jobs.claim(`worker-${suffix}`, new Date(), 30_000);
        expect(await write({ jobId: id, owner: `worker-${suffix}`, leaseToken: claim!.leaseToken })).toBe(true);
        await jobs.complete(id, `worker-${suffix}`, claim!.leaseToken, new Date());
      }
    };
    await invokeTwice("listing_generate", (fence) => pipeline.saveResult({ revisionId, title: "Title", description: "Description", attributes: [], styleApplied: "neutral", provider: "rules", fallbackUsed: true }, fence));
    await invokeTwice("pricing_calculate", (fence) => pipeline.saveReady({ revisionId, finalPrice: { amountMinor: "999", currency: "THB" }, breakdown: { ending: "9" } }, fence));
    await handle.pool.query("UPDATE product_revisions SET working_draft = working_draft || '{\"templateMatch\":{\"templateId\":\"default\",\"templateVersion\":1}}'::jsonb WHERE id = $1", [revisionId]);
    await invokeTwice("canvas_generate", (fence) => pipeline.saveOutputs({
      revisionId,
      remoteTaskId: "remote-1",
      assets: [{ remoteUrl: "https://out/1.jpg", sha256: "generated-hash", path: "/data/assets/ge/generated-hash.jpg", extension: "jpg", width: 1024, height: 1024 }],
      state: "succeeded"
    }, fence));
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM listing_drafts WHERE revision_id = $1", [revisionId])).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM pricing_runs WHERE revision_id = $1", [revisionId])).rows[0]?.count)).toBe(1);
    expect(Number((await handle.pool.query("SELECT COUNT(*) AS count FROM canvas_runs WHERE revision_id = $1", [revisionId])).rows[0]?.count)).toBe(1);
    const generated = await handle.pool.query<{ id: string; revision_id: string; kind: string; local_path: string }>(
      "SELECT id, revision_id, kind, local_path FROM assets WHERE revision_id = $1 AND kind = 'generated'",
      [revisionId]
    );
    expect(generated.rows).toHaveLength(1);
    expect(generated.rows[0]).toMatchObject({ revision_id: revisionId, kind: "generated", local_path: "/data/assets/ge/generated-hash.jpg" });
    const canvas = await handle.pool.query<{ outputs: string[] }>("SELECT outputs FROM canvas_runs WHERE revision_id = $1", [revisionId]);
    expect(canvas.rows[0]?.outputs).toEqual([generated.rows[0]?.id]);
    const draft = await handle.pool.query<{ working_draft: { finalAssetOrder?: string[] } }>(
      "SELECT working_draft FROM product_revisions WHERE id = $1",
      [revisionId]
    );
    expect(draft.rows[0]?.working_draft.finalAssetOrder).toEqual([generated.rows[0]?.id]);
  });

  test("loads source minor units without losing precision above Number.MAX_SAFE_INTEGER", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "large-money", displayName: "Large Money" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/large.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "large",
      workingDraft: { pricingInputs: {} }
    });
    await handle.pool.query(
      `UPDATE product_revisions SET source_payload = $2::jsonb WHERE id = $1`,
      [revisionId, JSON.stringify({ sourcePriceWire: { amountMinor: "900719925474099312345", currency: "CNY" }, weightKg: "1" })]
    );
    expect((await pipeline.loadInputs(revisionId)).sourceCostCny).toBe("9007199254740993123.45");
  });

  test("persists archive quality evidence and only loads genuinely ready scored images", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "quality-chain", displayName: "Quality Chain" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/quality.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "quality", workingDraft: {} });
    const jobId = await jobs.enqueue({ kind: "asset_archive", businessKey: "quality:archive", payload: { version: 1, revisionId } });
    const claim = await jobs.claim("quality-worker", new Date(), 30_000);
    expect(await pipeline.saveArchive({
      revisionId,
      state: "partial",
      assets: [
        {
          remoteUrl: "https://cdn.test/accepted.jpg", sha256: "accepted", path: "/assets/accepted.jpg", extension: "jpg",
          width: 1200, height: 1000, perceptualHash: "same-hash", clarity: 0.91, duplicateDistance: 8,
          watermarkProbability: 0.01, collageProbability: 0.02, nonProductProbability: 0.03,
          score: 0.87, chosenRole: "primary", rejectionReason: null
        },
        {
          remoteUrl: "https://cdn.test/rejected.jpg", sha256: "rejected", path: "/assets/rejected.jpg", extension: "jpg",
          width: 320, height: 320, perceptualHash: "rejected-hash", clarity: 0.8, duplicateDistance: 9,
          watermarkProbability: 0.01, collageProbability: 0.01, nonProductProbability: 0.01,
          score: 0.4, chosenRole: "detail", rejectionReason: "low_resolution"
        }
      ]
    }, { jobId, owner: "quality-worker", leaseToken: claim!.leaseToken })).toBe(true);

    const stored = await handle.pool.query(
      "SELECT remote_url, state, width, height, perceptual_hash, clarity, duplicate_distance, watermark_probability, collage_probability, non_product_probability, visual_score, chosen_role, rejection_reason FROM assets WHERE revision_id = $1 ORDER BY remote_url",
      [revisionId]
    );
    expect(stored.rows).toEqual([
      expect.objectContaining({ remote_url: "https://cdn.test/accepted.jpg", state: "ready", width: 1200, height: 1000, perceptual_hash: "same-hash", chosen_role: "primary", rejection_reason: null }),
      expect.objectContaining({ remote_url: "https://cdn.test/rejected.jpg", state: "rejected", width: 320, height: 320, perceptual_hash: "rejected-hash", chosen_role: "detail", rejection_reason: "low_resolution" })
    ]);
    expect((await pipeline.loadSelectionInputs(revisionId)).candidates).toEqual([
      { assetId: expect.any(String), url: "/assets/accepted.jpg", role: "primary", score: 0.87, perceptualHash: "same-hash" }
    ]);
  });

  test("ignores stale one-slot canvasInputCapacity and defaults TK workflow input selection to five images", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "canvas-capacity", displayName: "Canvas Capacity" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/capacity.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "capacity",
      workingDraft: {
        canvasInputCapacity: 1,
        templateMatch: { templateId: "default", templateVersion: 1 },
        imageSelection: { assetIds: ["asset-a", "asset-b"], referenceUrls: [], totalCount: 2 }
      }
    });
    await handle.pool.query(
      `INSERT INTO templates
       (id, template_key, name, target_locale, visual_style, prompt_fragment, reference_asset_ids, version, enabled)
       VALUES ('template-default-v1', 'default', 'Default', 'th-TH', 'clean ecommerce product photo', '', '[]'::jsonb, 1, true)`
    );
    await handle.pool.query(
      `INSERT INTO assets
       (id, product_id, revision_id, remote_url, kind, state, width, height, sha256, local_path, extension,
        perceptual_hash, clarity, duplicate_distance, watermark_probability, collage_probability, non_product_probability, visual_score, chosen_role)
       VALUES
       ('asset-a', $1, $2, 'https://cdn.test/a.jpg', 'detail', 'ready', 1200, 1200, 'hash-a', '/assets/a.jpg', 'jpg',
        'phash-a', 0.9, 8, 0.01, 0.01, 0.01, 0.9, 'primary'),
       ('asset-b', $1, $2, 'https://cdn.test/b.jpg', 'detail', 'ready', 1200, 1200, 'hash-b', '/assets/b.jpg', 'jpg',
        'phash-b', 0.8, 9, 0.01, 0.01, 0.01, 0.8, 'detail')`,
      [productId, revisionId]
    );

    await expect(pipeline.loadSelectionInputs(revisionId)).resolves.toMatchObject({
      capacity: 5
    });
    await expect(pipeline.loadPlan(revisionId)).resolves.toMatchObject({
      canvasInputCapacity: undefined,
      productImages: [
        expect.objectContaining({ assetId: "asset-a" }),
        expect.objectContaining({ assetId: "asset-b" })
      ]
    });
  });
});

describe("integration: job repository claim semantics", () => {
  test("enqueue and idempotent reuse append redacted audits in the same transaction", async () => {
    const input = {
      kind: "pricing_calculate",
      businessKey: "audit:job",
      payload: { version: 1 },
      audit: {
        actorType: "operator" as const,
        actorId: "local",
        action: "job.enqueue",
        targetKind: "job",
        payload: { source: "start-button" }
      }
    };
    const first = await jobs.enqueue(input);
    const second = await jobs.enqueue(input);
    expect(second).toBe(first);
    const events = await handle.pool.query(
      "SELECT target_id, payload, redacted FROM audit_events WHERE action = 'job.enqueue' ORDER BY created_at",
    );
    expect(events.rows).toEqual([
      { target_id: first, payload: { source: "start-button" }, redacted: true },
      { target_id: first, payload: { source: "start-button" }, redacted: true }
    ]);
  });

  test("persists a remote task only for the current owner and lease token", async () => {
    const id = await jobs.enqueue({ kind: "canvas_generate", businessKey: "canvas:persist-remote", payload: { version: 1 }, batchKey: "batch-remote" });
    const claimed = await jobs.claim("worker-a", new Date("2026-07-16T00:00:00Z"), 30_000);
    expect(claimed).toMatchObject({ jobId: id, batchKey: "batch-remote" });
    expect(await jobs.persistRemoteTask(id, "worker-b", claimed!.leaseToken, new Date("2026-07-16T00:00:01Z"), "remote-bad")).toBe(false);
    expect(await jobs.persistRemoteTask(id, "worker-a", claimed!.leaseToken, new Date("2026-07-16T00:00:01Z"), "remote-good")).toBe(true);
    const stored = await handle.pool.query("SELECT remote_task_id FROM jobs WHERE id = $1", [id]);
    expect(stored.rows[0]?.remote_task_id).toBe("remote-good");
  });

  test("persists one fenced Miaoshou reconciliation expectation and fails closed on ambiguity", async () => {
    const now = new Date("2026-07-16T00:00:00Z");
    const firstId = await jobs.enqueue({
      kind: "miaoshou_edit",
      businessKey: "edit:expectation-1",
      payload: { version: 1, approvalSnapshotId: "approval-1" }
    });
    const first = await jobs.claim("worker-1", now, 30_000);
    expect(first?.jobId).toBe(firstId);
    const context = createMiaoshouReconciliationContext({
      jobId: firstId,
      approvalSnapshotId: "approval-1",
      canonicalSuccessDetailId: "3799770548",
      sourceItemId: "892408514788",
      approvalSnapshotDigest: "a".repeat(64),
      orderedRemoteAssetUrlSha256: ["b".repeat(64)],
      expectedDetail: { version: 1, title: "approved", imgUrlSha256: ["b".repeat(64)] }
    });
    expect(await jobs.persistMiaoshouReconciliationContext(
      firstId, "worker-1", first!.leaseToken, new Date("2026-07-16T00:00:01Z"), context
    )).toBe(true);
    await handle.pool.query(
      `UPDATE jobs SET status = 'needs_input', owner = NULL, lease_token = NULL,
         lease_expires_at = NULL,
         error = '{"code":"reconcile_required"}'::jsonb,
         remote_task_id = $2 WHERE id = $1`,
      [firstId, `canonical:3799770548:ctx:${context.contextDigest}`]
    );

    await expect(jobs.loadMiaoshouReconciliationContext("3799770548", "892408514788"))
      .resolves.toEqual(context);
    const persisted = await handle.pool.query("SELECT payload FROM jobs WHERE id = $1", [firstId]);
    expect(JSON.stringify(persisted.rows[0].payload)).not.toContain("https://stage.test/a.png");
    await handle.pool.query(
      `UPDATE jobs SET payload = jsonb_set(payload, '{reconciliationContext,expectedDetail,title}', '"tampered"'::jsonb) WHERE id = $1`,
      [firstId]
    );
    await expect(jobs.loadMiaoshouReconciliationContext("3799770548", "892408514788"))
      .resolves.toBeUndefined();
    await handle.pool.query("UPDATE jobs SET payload = jsonb_set(payload, '{reconciliationContext}', $2::jsonb) WHERE id = $1", [firstId, JSON.stringify(context)]);

    const secondId = await jobs.enqueue({
      kind: "miaoshou_edit",
      businessKey: "edit:expectation-2",
      payload: { version: 1, approvalSnapshotId: "approval-2" }
    });
    const second = await jobs.claim("worker-2", now, 30_000);
    expect(second?.jobId).toBe(secondId);
    expect(await jobs.persistMiaoshouReconciliationContext(
      secondId, "worker-2", second!.leaseToken, new Date("2026-07-16T00:00:01Z"), createMiaoshouReconciliationContext({
        ...context, jobId: secondId, approvalSnapshotId: "approval-2"
      })
    )).toBe(true);

    const secondContext = (await handle.pool.query("SELECT payload->'reconciliationContext' AS context FROM jobs WHERE id = $1", [secondId])).rows[0].context;
    await handle.pool.query("UPDATE jobs SET remote_task_id = $2 WHERE id = $1", [secondId, `canonical:3799770548:ctx:${secondContext.contextDigest}`]);

    await expect(jobs.loadMiaoshouReconciliationContext("3799770548", "892408514788"))
      .resolves.toBeUndefined();
    expect(JSON.stringify(persisted.rows[0].payload)).not.toMatch(/authorization|cookie|secret/i);
  });

  test("rolls back a newly inserted job when its same-transaction audit cannot serialize", async () => {
    await expect(jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "audit:rollback",
      payload: { version: 1 },
      audit: {
        actorType: "operator",
        action: "job.enqueue",
        targetKind: "job",
        payload: { safeValue: 1n }
      }
    })).rejects.toThrow();
    const count = await handle.pool.query("SELECT count(*)::int AS count FROM jobs WHERE business_key = 'audit:rollback'");
    expect(count.rows[0].count).toBe(0);
  });

  test("rejects secrets and raw transport data from audit payloads", async () => {
    await expect(jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "audit:secret",
      payload: { version: 1 },
      audit: {
        actorType: "operator",
        action: "job.enqueue",
        targetKind: "job",
        payload: { authorizationHeader: "Bearer secret" }
      }
    })).rejects.toThrow(/audit payload/i);
  });

  test("global and batch pause/resume are persisted and block claims", async () => {
    const batchJob = await jobs.enqueue({ kind: "pricing_calculate", businessKey: "control:batch", batchKey: "batch-1", payload: { version: 1 } });
    await jobs.setGlobalPaused(true);
    expect(await jobs.claim("worker", new Date("2026-07-16T00:00:00Z"), 30_000)).toBeNull();
    await jobs.setGlobalPaused(false);
    expect(await jobs.pauseBatch("batch-1", "operator_pause")).toBe(1);
    expect(await jobs.claim("worker", new Date("2026-07-16T00:00:00Z"), 30_000)).toBeNull();
    expect(await jobs.resumeBatch("batch-1")).toBe(1);
    expect((await jobs.claim("worker", new Date("2026-07-16T00:00:00Z"), 30_000))?.jobId).toBe(batchJob);
  });

  test("task cancel and safe retry are persisted while external unknown results cannot be retried", async () => {
    const cancelled = await jobs.enqueue({ kind: "pricing_calculate", businessKey: "control:cancel", payload: { version: 1 } });
    expect(await jobs.cancel(cancelled, "operator_cancelled")).toBe(true);
    let row = await handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [cancelled]);
    expect(row.rows[0]).toMatchObject({ status: "failed", error: { code: "cancelled" } });
    expect(await jobs.retrySafe(cancelled, new Date("2026-07-16T00:00:00Z"))).toBe(true);
    row = await handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [cancelled]);
    expect(row.rows[0]).toMatchObject({ status: "queued", error: null });

    const external = await jobs.enqueue({ kind: "canvas_generate", businessKey: "control:external", payload: { version: 1 } });
    await handle.pool.query("UPDATE jobs SET status = 'needs_input', remote_task_id = 'remote-1', error = '{\"code\":\"reconcile_required\"}'::jsonb WHERE id = $1", [external]);
    expect(await jobs.retrySafe(external, new Date("2026-07-16T00:00:00Z"))).toBe(false);

    const recoverableCanvas = await jobs.enqueue({ kind: "canvas_generate", businessKey: "control:canvas-reconcile-failed", payload: { version: 1 } });
    await handle.pool.query("UPDATE jobs SET status = 'needs_input', remote_task_id = 'remote-2', error = '{\"code\":\"reconcile_failed\"}'::jsonb WHERE id = $1", [recoverableCanvas]);
    expect(await jobs.retrySafe(recoverableCanvas, new Date("2026-07-16T00:00:00Z"))).toBe(true);
    row = await handle.pool.query("SELECT status, remote_task_id, error FROM jobs WHERE id = $1", [recoverableCanvas]);
    expect(row.rows[0]).toMatchObject({ status: "queued", remote_task_id: "remote-2", error: null });

    const recoverableCanvasArchive = await jobs.enqueue({ kind: "canvas_generate", businessKey: "control:canvas-zero-valid-outputs", payload: { version: 1 } });
    await handle.pool.query("UPDATE jobs SET status = 'needs_input', remote_task_id = 'remote-3', error = '{\"code\":\"canvas_zero_valid_outputs\"}'::jsonb WHERE id = $1", [recoverableCanvasArchive]);
    expect(await jobs.retrySafe(recoverableCanvasArchive, new Date("2026-07-16T00:00:00Z"))).toBe(true);
    row = await handle.pool.query("SELECT status, remote_task_id, error FROM jobs WHERE id = $1", [recoverableCanvasArchive]);
    expect(row.rows[0]).toMatchObject({ status: "queued", remote_task_id: "remote-3", error: null });

    const unknownWithoutRemoteId = await jobs.enqueue({ kind: "canvas_generate", businessKey: "control:unknown-without-id", payload: { version: 1 } });
    await handle.pool.query("UPDATE jobs SET status = 'needs_input', remote_task_id = NULL, error = '{\"code\":\"reconcile_required\"}'::jsonb WHERE id = $1", [unknownWithoutRemoteId]);
    expect(await jobs.retrySafe(unknownWithoutRemoteId, new Date("2026-07-16T00:00:00Z"))).toBe(false);
  });

  test("exhausting a retry stores a terminal ExternalFailure shape", async () => {
    const exhausted = await jobs.enqueue({
      kind: "canvas_generate",
      businessKey: "control:retry-exhausted",
      payload: { version: 1 },
      maxAttempts: 1
    });
    const claimed = await jobs.claim("worker-exhausted", new Date("2026-07-16T00:00:00Z"), 30_000);
    expect(claimed?.jobId).toBe(exhausted);
    expect(await jobs.retry(
      exhausted,
      "worker-exhausted",
      claimed!.leaseToken,
      new Date("2026-07-16T00:00:01Z"),
      30_000,
      {
        kind: "retryable",
        code: "canvas.network",
        safeMessage: "Canvas is temporarily unavailable"
      }
    )).toBe(true);

    const row = await handle.pool.query("SELECT status, error, next_attempt_at FROM jobs WHERE id = $1", [exhausted]);
    expect(row.rows[0]).toMatchObject({
      status: "failed",
      error: {
        kind: "fatal",
        code: "attempts_exhausted",
        safeMessage: "Maximum attempts exhausted"
      },
      next_attempt_at: null
    });
  });

  test("an expired internal job at its attempt limit stores a terminal ExternalFailure shape", async () => {
    const exhausted = await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "control:expired-exhausted",
      payload: { version: 1 },
      maxAttempts: 1
    });
    const startedAt = new Date("2026-07-16T00:00:00Z");
    expect((await jobs.claim("worker-expired", startedAt, 1_000))?.jobId).toBe(exhausted);
    expect(await jobs.releaseExpired(new Date("2026-07-16T00:00:02Z"))).toBe(1);

    const row = await handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [exhausted]);
    expect(row.rows[0]).toMatchObject({
      status: "failed",
      error: {
        kind: "fatal",
        code: "attempts_exhausted",
        safeMessage: "Maximum attempts exhausted"
      }
    });
  });

  test("historical Miaoshou result_unknown without a marker stays manual and cannot be claimed for edit", async () => {
    const jobId = await jobs.enqueue({
      kind: "miaoshou_edit",
      businessKey: "historical-result-unknown-without-marker",
      payload: { version: 1, approvalSnapshotId: "legacy-approval" }
    });
    await handle.pool.query(
      `UPDATE jobs SET status = 'needs_input', remote_task_id = NULL,
         error = '{"code":"reconcile_required"}'::jsonb WHERE id = $1`,
      [jobId]
    );

    expect(await jobs.retrySafe(jobId, new Date())).toBe(false);
    expect(await jobs.claim("ordinary-worker", new Date(), 30_000)).toBeNull();
    expect(await jobs.claimReconciliation("reconcile-worker", new Date(), 30_000)).toBeNull();
    expect((await handle.pool.query("SELECT status FROM jobs WHERE id = $1", [jobId])).rows[0]?.status).toBe("needs_input");
  });

  test("expired paid or external jobs require review instead of being automatically charged again", async () => {
    const startedAt = new Date("2026-07-16T00:00:00Z");
    const expiredAt = new Date("2026-07-16T00:00:01Z");
    for (const kind of ["listing_generate", "exchange_rate_refresh", "miaoshou_prepare_writeback"]) {
      const id = await jobs.enqueue({ kind, businessKey: `paid-expiry:${kind}`, payload: { version: 1 } });
      expect((await jobs.claim(`worker-${kind}`, startedAt, 10))?.jobId).toBe(id);
      expect(await jobs.releaseExpired(expiredAt)).toBe(1);
      const row = await handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [id]);
      expect(row.rows[0]).toMatchObject({
        status: "needs_input",
        error: { kind: "reconcile_required", code: "reconcile_required" }
      });
      expect(await jobs.retrySafe(id, expiredAt)).toBe(false);
    }
  });

  test("two concurrent claims with same owner/now/lease return only ONE job", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/456.html",
      locale: "th-TH",
      currency: "THB"
    });
    const revId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "t",
      workingDraft: {}
    });
    // Sequential double-claim invariant (brief: "concurrent two-worker simulation if
    // feasible without timing flakiness, else by sequential double-claim"). Only one
    // queued job is available; the second claim must observe it as running and return null.
    await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: `pricing:${revId}:only`,
      payload: { version: 1, revisionId: revId },
      maxAttempts: 3
    });

    const owner = "worker-A";
    const now = new Date("2026-07-01T00:00:00Z");
    const leaseMs = 30_000;
    const first = await jobs.claim(owner, now, leaseMs);
    const second = await jobs.claim(owner, now, leaseMs);

    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  test("with many queued jobs, a second claim immediately returns ONE more job (race safety)", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/456b.html",
      locale: "th-TH",
      currency: "THB"
    });
    const revId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "t",
      workingDraft: {}
    });

    for (let i = 0; i < 5; i++) {
      await jobs.enqueue({
        kind: "pricing_calculate",
        businessKey: `pricing:${revId}:burst:${i}`,
        payload: { version: 1, revisionId: revId },
        maxAttempts: 3
      });
    }

    const owner = "worker-A";
    const now = new Date("2026-07-01T00:00:00Z");
    const leaseMs = 30_000;
    const first = await jobs.claim(owner, now, leaseMs);
    const second = await jobs.claim(owner, now, leaseMs);

    expect(first).not.toBeNull();
    // With multiple queued jobs, second claim MUST pick a different row (not the same).
    expect(second).not.toBeNull();
    expect(second!.jobId).not.toBe(first!.jobId);
  });

  test("a stale lease owner cannot heartbeat, complete, or fail a re-claimed job", async () => {
    await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "lease:fencing",
      payload: { version: 1, revisionId: "rev-fencing" }
    });
    const first = await jobs.claim("worker-old", new Date("2026-07-01T00:00:00Z"), 1_000);
    expect(first).not.toBeNull();
    await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"));
    const second = await jobs.claim("worker-new", new Date("2026-07-01T00:00:02Z"), 30_000);
    expect(second).not.toBeNull();
    expect(second!.leaseToken).not.toBe(first!.leaseToken);

    await expect(
      jobs.heartbeat(first!.jobId, "worker-old", first!.leaseToken, new Date("2026-07-01T00:00:03Z"), 1_000)
    ).resolves.toBe(false);
    await expect(
      jobs.complete(first!.jobId, "worker-old", first!.leaseToken, new Date("2026-07-01T00:00:03Z"))
    ).resolves.toBe(false);
    await expect(
      jobs.fail(
        first!.jobId,
        "worker-old",
        first!.leaseToken,
        new Date("2026-07-01T00:00:03Z"),
        { code: "stale" }
      )
    ).resolves.toBe(false);
    await expect(
      jobs.complete(second!.jobId, "worker-new", second!.leaseToken, new Date("2026-07-01T00:00:03Z"))
    ).resolves.toBe(true);
  });

  test("lease owner is fenced after expiry even before releaseExpired runs", async () => {
    await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "lease:expired-window",
      payload: { version: 1 }
    });
    const claim = await jobs.claim("worker-a", new Date("2026-07-01T00:00:00Z"), 1_000);
    expect(claim).not.toBeNull();
    const expiredAt = new Date("2026-07-01T00:00:01Z");
    await expect(
      jobs.heartbeat(claim!.jobId, "worker-a", claim!.leaseToken, expiredAt, 30_000)
    ).resolves.toBe(false);
    await expect(
      jobs.complete(claim!.jobId, "worker-a", claim!.leaseToken, expiredAt)
    ).resolves.toBe(false);
    await expect(
      jobs.fail(claim!.jobId, "worker-a", claim!.leaseToken, expiredAt, { code: "late" })
    ).resolves.toBe(false);
    const row = await handle.pool.query("SELECT status, owner FROM jobs WHERE id = $1", [claim!.jobId]);
    expect(row.rows[0]).toMatchObject({ status: "running", owner: "worker-a" });
  });

  test("claim respects next_attempt_at and max_attempts", async () => {
    const futureId = await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "retry:future",
      payload: { version: 1 },
      maxAttempts: 3
    });
    const exhaustedId = await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "retry:exhausted",
      payload: { version: 1 },
      maxAttempts: 1
    });
    await handle.pool.query("UPDATE jobs SET next_attempt_at = $2 WHERE id = $1", [
      futureId,
      new Date("2026-07-02T00:00:00Z")
    ]);
    await handle.pool.query("UPDATE jobs SET attempt = max_attempts WHERE id = $1", [exhaustedId]);
    expect(await jobs.claim("worker", new Date("2026-07-01T00:00:00Z"), 30_000)).toBeNull();
  });

  test("expired external-side-effect jobs go to reconciliation instead of being requeued", async () => {
    const externalId = await jobs.enqueue({
      kind: "canvas_generate",
      businessKey: "external:canvas",
      payload: { version: 1 }
    });
    const safeId = await jobs.enqueue({
      kind: "pricing_calculate",
      businessKey: "internal:pricing",
      payload: { version: 1 }
    });
    const now = new Date("2026-07-01T00:00:00Z");
    const external = await jobs.claim("worker-a", now, 1_000);
    const safe = await jobs.claim("worker-a", now, 1_000);
    expect(new Set([external!.jobId, safe!.jobId])).toEqual(new Set([externalId, safeId]));
    await handle.pool.query("UPDATE jobs SET remote_task_id = 'remote-123' WHERE id = $1", [externalId]);

    expect(await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"))).toBe(2);
    const result = await handle.pool.query(
      "SELECT id, status, error FROM jobs WHERE id = ANY($1::text[]) ORDER BY id",
      [[externalId, safeId]]
    );
    const byId = new Map(result.rows.map((row) => [row.id, row]));
    expect(byId.get(externalId).status).toBe("needs_input");
    expect(byId.get(externalId).error.code).toBe("reconcile_required");
    expect(byId.get(safeId).status).toBe("queued");
  });

  test("expired miaoshou edit also marks its aggregate result_unknown", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/sync.html",
      sourceItemId: "sync",
      locale: "th-TH",
      currency: "THB"
    });
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "ready",
      workingDraft: {}
    });
    const snapshotId = "appr-expired-sync";
    await handle.pool.query(
      `INSERT INTO approval_snapshots
        (id, product_id, revision_id, draft_version, listing_run_id, pricing_run_id,
         template_version, ordered_final_asset_ids, source_platform, source_canonical_url,
         source_item_id, canonical_success_detail_id, locale, currency, title, description,
         attributes, price_minor, price_currency, stock, weight_kg, skus, state)
       VALUES ($1, $2, $3, 1, 'listing-1', 'pricing-1', 1, '[]'::jsonb, '1688',
               'https://detail.1688.com/offer/sync.html', 'sync', 'canonical-1',
               'th-TH', 'THB', 'title', 'description', '[]'::jsonb, '100', 'THB', 1,
               '0.3', '[]'::jsonb, 'approved')`,
      [snapshotId, productId, revisionId]
    );
    await handle.pool.query(
      "INSERT INTO miaoshou_syncs (id, approval_snapshot_id, state) VALUES ('sync-expired', $1, 'syncing')",
      [snapshotId]
    );
    const jobId = await jobs.enqueue({
      kind: "miaoshou_edit",
      businessKey: "miaoshou-edit:expired",
      payload: { version: 1, approvalSnapshotId: snapshotId }
    });
    await jobs.claim("worker-a", new Date("2026-07-01T00:00:00Z"), 1_000);

    await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"));
    const [job, sync] = await Promise.all([
      handle.pool.query("SELECT status, error FROM jobs WHERE id = $1", [jobId]),
      handle.pool.query("SELECT state, error FROM miaoshou_syncs WHERE approval_snapshot_id = $1", [snapshotId])
    ]);
    expect(job.rows[0].status).toBe("needs_input");
    expect(job.rows[0].error.code).toBe("reconcile_required");
    expect(sync.rows[0].state).toBe("result_unknown");
    expect(sync.rows[0].error.code).toBe("reconcile_required");
  });

  test.each(["succeeded", "failed"] as const)(
    "expired miaoshou edit does not downgrade terminal sync state %s",
    async (terminalState) => {
      const operatorId = await catalog.upsertLocalOperator({
        handle: `terminal-${terminalState}`,
        displayName: `Terminal ${terminalState}`
      });
      const productId = await catalog.insertProduct({
        operatorId,
        sourceUrl: `https://detail.1688.com/offer/terminal-${terminalState}.html`,
        sourceItemId: `terminal-${terminalState}`,
        locale: "th-TH",
        currency: "THB"
      });
      const revisionId = await catalog.insertRevision({
        productId,
        draftVersion: 1,
        sourceTitle: "terminal",
        workingDraft: {}
      });
      const snapshotId = `appr-terminal-${terminalState}`;
      await handle.pool.query(
        `INSERT INTO approval_snapshots
          (id, product_id, revision_id, draft_version, listing_run_id, pricing_run_id,
           template_version, ordered_final_asset_ids, source_platform, source_canonical_url,
           source_item_id, canonical_success_detail_id, locale, currency, title, description,
           attributes, price_minor, price_currency, stock, weight_kg, skus, state)
         VALUES ($1, $2, $3, 1, 'listing-terminal', 'pricing-terminal', 1, '[]'::jsonb,
                 '1688', $4, $5, 'canonical-terminal', 'th-TH', 'THB', 'title',
                 'description', '[]'::jsonb, '100', 'THB', 1, '0.3', '[]'::jsonb,
                 'approved')`,
        [
          snapshotId,
          productId,
          revisionId,
          `https://detail.1688.com/offer/terminal-${terminalState}.html`,
          `terminal-${terminalState}`
        ]
      );
      await handle.pool.query(
        `INSERT INTO miaoshou_syncs (id, approval_snapshot_id, state, error)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [
          `sync-terminal-${terminalState}`,
          snapshotId,
          terminalState,
          JSON.stringify({ code: `terminal_${terminalState}` })
        ]
      );
      const jobId = await jobs.enqueue({
        kind: "miaoshou_edit",
        businessKey: `miaoshou-edit:terminal:${terminalState}`,
        payload: { version: 1, approvalSnapshotId: snapshotId }
      });
      const claim = await jobs.claim(
        "worker-terminal",
        new Date("2026-07-01T00:00:00Z"),
        1_000
      );
      expect(claim?.jobId).toBe(jobId);

      await jobs.releaseExpired(new Date("2026-07-01T00:00:02Z"));

      const sync = await handle.pool.query(
        "SELECT state, error FROM miaoshou_syncs WHERE approval_snapshot_id = $1",
        [snapshotId]
      );
      expect(sync.rows[0]).toEqual({
        state: terminalState,
        error: { code: `terminal_${terminalState}` }
      });
    }
  );
});

describe("integration: Canvas daily quota", () => {
  test("atomically caps concurrent reservations and reuses a run reservation", async () => {
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) =>
      canvasQuota.reserve({ runKey: `run-${index}`, day: "2026-07-16", limit: 2 })
    ));
    expect(results.filter(Boolean)).toHaveLength(2);
    const winner = results.findIndex(Boolean);
    expect(await canvasQuota.reserve({ runKey: `run-${winner}`, day: "2026-07-16", limit: 2 })).toBe(true);
    const rows = await handle.pool.query("SELECT run_key FROM canvas_daily_reservations WHERE day_key = '2026-07-16'");
    expect(rows.rowCount).toBe(2);
  });
});

describe("integration: exchange rate snapshots", () => {
  test("records source, observedAt, manual override provenance", async () => {
    const observedAt = "2026-07-01T00:00:00.000Z";
    await rates.record({
      base: "CNY",
      target: "THB",
      rate: "4.80",
      source: "provider",
      observedAt,
      isStale: false
    });
    await rates.recordManualOverride({
      base: "CNY",
      target: "THB",
      rate: "5.00",
      observedAt
    });

    const all = await rates.listAll();
    const provider = all.find((s) => s.source === "provider");
    const manual = all.find((s) => s.source === "manual");
    expect(provider).toBeDefined();
    expect(manual).toBeDefined();
    expect(provider!.rate).toBe("4.80");
    expect(manual!.rate).toBe("5.00");
    expect(await rates.latestEffective("CNY", "THB")).toMatchObject({ id: manual!.id, source: "manual", rate: "5.00" });
    expect(await rates.markStale(provider!.id)).toBe(true);
    expect(await rates.latestSuccessful("CNY", "THB")).toMatchObject({ id: manual!.id, source: "manual", isStale: false });
  });
});

describe("integration: automation run repository", () => {
  test("starts only complete V3 local captures", async () => {
    const operatorId = await catalog.upsertLocalOperator({
      handle: "local-quality-gate",
      displayName: "Local Quality Gate"
    });
    const productId = await catalog.insertProduct({
      operatorId,
      sourceUrl: "https://detail.1688.com/offer/932820256180.html",
      sourceItemId: "932820256180",
      locale: "th-TH",
      currency: "THB"
    });
    await handle.pool.query(
      "UPDATE products SET state_source = 'local_captured' WHERE id = $1",
      [productId]
    );
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "洛阳千易针织有限公司",
      workingDraft: {}
    });
    await handle.pool.query(
      `UPDATE product_revisions
       SET source_payload = $2::jsonb
       WHERE id = $1`,
      [
        revisionId,
        JSON.stringify({
          captureQuality: "detail_page",
          mainImages: [{ url: "https://cbu01.alicdn.com/164-32.png" }]
        })
      ]
    );

    await expect(automations.createOrReuseAndEnqueue({
      revisionId,
      processingVersion: 1
    })).rejects.toThrow("local_capture_quality_invalid");

    await handle.pool.query(
      `UPDATE product_revisions
       SET source_payload = jsonb_set(source_payload, '{captureQuality}', '"detail_page_partial"')
       WHERE id = $1`,
      [revisionId]
    );
    await expect(automations.createOrReuseAndEnqueue({
      revisionId,
      processingVersion: 1
    })).rejects.toThrow("local_capture_quality_invalid");

    const runs = await handle.pool.query(
      "SELECT count(*)::integer AS count FROM automation_runs WHERE revision_id = $1",
      [revisionId]
    );
    expect(runs.rows[0]?.count).toBe(0);

    await handle.pool.query(
      `UPDATE product_revisions
       SET source_payload = jsonb_set(source_payload, '{captureQuality}', '"detail_page_complete"')
       WHERE id = $1`,
      [revisionId]
    );
    await expect(automations.createOrReuseAndEnqueue({
      revisionId,
      processingVersion: 1
    })).resolves.toMatchObject({ created: true });
  });

  test("concurrent createOrReuseAndEnqueue creates one run and one asset archive job", async () => {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/789.html",
      locale: "th-TH",
      currency: "THB"
    });
    const revId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "t",
      workingDraft: {}
    });
    await handle.pool.query(
      `UPDATE product_revisions SET source_payload = $2::jsonb WHERE id = $1`,
      [revId, JSON.stringify({
        mainImages: [
          { url: "https://cdn.example/main.jpg", width: 1200, height: 1200 },
          { url: "https://cdn.example/shared.jpg" }
        ],
        detailImages: [
          { url: "https://cdn.example/shared.jpg" },
          { url: "https://cdn.example/detail.jpg" },
          { url: "file:///not-remote.jpg" }
        ]
      })]
    );

    const [first, second] = await Promise.all([
      automations.createOrReuseAndEnqueue({ revisionId: revId, processingVersion: 1 }),
      automations.createOrReuseAndEnqueue({ revisionId: revId, processingVersion: 1 })
    ]);
    expect([first.created, second.created].sort()).toEqual([false, true]);
    expect(first.runId).toBe(second.runId);

    const runs = await handle.pool.query(
      "SELECT id FROM automation_runs WHERE revision_id = $1 AND processing_version = 1",
      [revId]
    );
    const queued = await handle.pool.query(
      "SELECT kind, payload FROM jobs WHERE business_key = $1",
      [`automation:${first.runId}:boot`]
    );
    expect(runs.rowCount).toBe(1);
    expect(queued.rowCount).toBe(1);
    expect(queued.rows[0].kind).toBe("asset_archive");
    expect(queued.rows[0].payload).toEqual({
      version: 1,
      revisionId: revId,
      remoteUrls: [
        "https://cdn.example/main.jpg",
        "https://cdn.example/shared.jpg",
        "https://cdn.example/detail.jpg"
      ]
    });
  });

  test("records every repeated human start against the reused run", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "audit-start", displayName: "Audit Start" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/audit.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "audit", workingDraft: {} });
    const input = {
      revisionId,
      processingVersion: 1,
      audit: {
        actorType: "operator" as const,
        actorId: "local",
        action: "automation.start",
        targetKind: "automation_run",
        payload: { surface: "product-workbench" }
      }
    };
    const first = await automations.createOrReuseAndEnqueue(input);
    const second = await automations.createOrReuseAndEnqueue(input);
    expect(second.runId).toBe(first.runId);
    const events = await handle.pool.query("SELECT target_id FROM audit_events WHERE action = 'automation.start'");
    expect(events.rows.map((row) => row.target_id)).toEqual([first.runId, first.runId]);
  });

  test("rolls back automation run and boot job when same-transaction audit fails", async () => {
    const operatorId = await catalog.upsertLocalOperator({ handle: "audit-run-rollback", displayName: "Audit rollback" });
    const productId = await catalog.insertProduct({ operatorId, sourceUrl: "https://detail.1688.com/offer/rollback.html", locale: "th-TH", currency: "THB" });
    const revisionId = await catalog.insertRevision({ productId, draftVersion: 1, sourceTitle: "rollback", workingDraft: {} });
    await expect(automations.createOrReuseAndEnqueue({
      revisionId,
      processingVersion: 1,
      audit: { actorType: "operator", action: "automation.start", targetKind: "automation_run", payload: { safeValue: 1n } }
    })).rejects.toThrow();
    const [runs, queued] = await Promise.all([
      handle.pool.query("SELECT count(*)::int AS count FROM automation_runs WHERE revision_id = $1", [revisionId]),
      handle.pool.query("SELECT count(*)::int AS count FROM jobs WHERE payload->>'revisionId' = $1", [revisionId])
    ]);
    expect(runs.rows[0].count).toBe(0);
    expect(queued.rows[0].count).toBe(0);
  });
});

describe("integration: ApprovalRepository.confirmAndEnqueue", () => {
  async function readyApprovalFixture(options: { canonical?: boolean } = {}) {
    const opId = await catalog.upsertLocalOperator({
      handle: "local-operator",
      displayName: "Local Operator"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/abc.html",
      sourceItemId: "abc",
      locale: "th-TH",
      currency: "THB"
    });
    await handle.pool.query(
      `UPDATE products
       SET canonical_success_detail_id = $2, state_automation = 'ready',
           state_source = CASE WHEN $2::text IS NULL THEN 'local_captured' ELSE 'success' END
       WHERE id = $1`,
      [productId, options.canonical === false ? null : "detail-canonical"]
    );
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "Source",
      workingDraft: {
        listingRunId: "run-listing-1",
        pricingRunId: "run-pricing-1",
        templateMatch: { templateId: "template-1", templateVersion: 3 },
        finalAssetOrder: ["asset-a", "asset-b"]
      }
    });
    await handle.pool.query(
      "UPDATE product_revisions SET source_payload = $2::jsonb WHERE id = $1",
      [revisionId, JSON.stringify({
        sourceItemId: "abc",
        itemNumber: "ITEM-1",
        sourceStock: 12,
        weightKg: "0.35",
        dimensionsCm: { lengthCm: "30", widthCm: "20", heightCm: "4" },
        skus: [{ skuId: "sku-red", attributes: { color: "red" }, priceWire: { amountMinor: "2000", currency: "CNY" }, stock: 6, imageUrl: "https://source.test/red.jpg" }]
      })]
    );
    await handle.pool.query(
      `INSERT INTO listing_drafts
       (id, product_id, revision_id, draft_version, target_locale, style, title, description, attributes)
       VALUES ('run-listing-1', $1, $2, 1, 'th-TH', 'neutral', 'Thai title', 'Thai description', '[{"name":"material","value":"cotton"}]'::jsonb)`,
      [productId, revisionId]
    );
    await handle.pool.query(
      `INSERT INTO pricing_runs
       (id, product_id, revision_id, draft_version, state, final_price_minor, final_currency)
       VALUES ('run-pricing-1', $1, $2, 1, 'ready', '25900', 'THB')`,
      [productId, revisionId]
    );
    await handle.pool.query(
      `INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, local_path, extension)
       VALUES
       ('asset-a', $1, $2, 'https://source.test/red.jpg', 'generated', 'ready', '/assets/a.jpg', 'jpg'),
       ('asset-b', $1, $2, 'https://source.test/b.jpg', 'generated', 'ready', '/assets/b.jpg', 'jpg')`,
      [productId, revisionId]
    );
    // T13 fix: slot backing for accepted assets. Existing tests must keep green
    // while the slot filter is active, so each ready asset is wired to a
    // succeeded, archived, non-excluded slot row.
    const readyApprovalTemplateId = newId("rtmpl");
    await handle.pool.query(
      `INSERT INTO image_generation_templates (id, name, category_key, enabled, created_at, updated_at)
       VALUES ($1, 'Ready Approval Template', 'dress', true, now(), now())`,
      [readyApprovalTemplateId]
    );
    const readyApprovalTemplateVersionId = newId("tv");
    await handle.pool.query(
      `INSERT INTO image_generation_template_versions (id, template_id, version, lifecycle_state, recipe, created_at)
       VALUES ($1, $2, 3, 'active', '{}'::jsonb, now())`,
      [readyApprovalTemplateVersionId, readyApprovalTemplateId]
    );
    const readyApprovalBatchId = newId("batch");
    await handle.pool.query(
      `INSERT INTO image_generation_batches
        (id, product_id, revision_id, idempotency_key, selected_asset_ids, requested_output_count,
         category_key, template_id, template_version_id, template_version, recipe_snapshot,
         product_facts_snapshot, product_facts_digest, state)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, 2, 'dress', $5, $6, 3, '{}'::jsonb, '{}'::jsonb, 'digest', 'succeeded')`,
      [readyApprovalBatchId, productId, revisionId, `ready-key-${newId("idem")}`, readyApprovalTemplateId, readyApprovalTemplateVersionId]
    );
    await handle.pool.query(
      `INSERT INTO image_generation_slots (id, batch_id, slot_number, role, state, archived_asset_id)
       VALUES
        ($1, $2, 1, 'primary', 'succeeded', 'asset-a'),
        ($3, $2, 2, 'detail', 'succeeded', 'asset-b')`,
      [newId("slot"), readyApprovalBatchId, newId("slot")]
    );
    return { productId, revisionId };
  }

  test("atomically creates one immutable snapshot, sync and edit job", async () => {
    const { productId, revisionId } = await readyApprovalFixture();
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    };
    const first = await approvals.confirmAndEnqueue(command);
    const second = await approvals.confirmAndEnqueue(command);
    expect(second).toEqual(first);
    const [snapshots, syncs, queued] = await Promise.all([
      handle.pool.query("SELECT * FROM approval_snapshots"),
      handle.pool.query("SELECT count(*)::int AS count FROM miaoshou_syncs"),
      handle.pool.query("SELECT count(*)::int AS count FROM jobs WHERE kind = 'miaoshou_edit'")
    ]);
    expect(snapshots.rows).toHaveLength(1);
    expect(snapshots.rows[0]).toMatchObject({
      id: first.approvalSnapshotId,
      product_id: productId,
      revision_id: revisionId,
      ordered_final_asset_ids: ["asset-a", "asset-b"],
      source_item_id: "abc",
      canonical_success_detail_id: "detail-canonical",
      title: "Thai title",
      price_minor: null,
      price_currency: null,
      weight_kg: null,
      state: "approved"
    });
    expect(snapshots.rows[0].skus[0]).toMatchObject({ skuId: "sku-red", assetIds: ["asset-a"] });
    expect(snapshots.rows[0].skus[0].priceWire).toBeUndefined();
    expect(syncs.rows[0].count).toBe(1);
    expect(queued.rows[0].count).toBe(1);
  });

  test("queues a late Miaoshou import when a local capture has no canonical detail id", async () => {
    const { productId } = await readyApprovalFixture({ canonical: false });

    const confirmed = await approvals.confirmAndEnqueue({
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    });

    const snapshot = await handle.pool.query(
      "SELECT canonical_success_detail_id FROM approval_snapshots WHERE id = $1",
      [confirmed.approvalSnapshotId]
    );
    const queued = await handle.pool.query(
      "SELECT kind, payload FROM jobs WHERE payload->>'approvalSnapshotId' = $1",
      [confirmed.approvalSnapshotId]
    );
    expect(snapshot.rows[0]?.canonical_success_detail_id).toBeNull();
    expect(queued.rows).toHaveLength(1);
    expect(queued.rows[0]).toMatchObject({
      kind: "miaoshou_prepare_writeback",
      payload: {
        version: 1,
        approvalSnapshotId: confirmed.approvalSnapshotId,
        productId,
        sourceUrl: "https://detail.1688.com/offer/abc.html"
      }
    });

    const claimed = await jobs.claim("worker-prepare", new Date(), 30_000);
    expect(claimed?.kind).toBe("miaoshou_prepare_writeback");
    const bound = await approvals.bindCanonicalAndEnqueueEdit({
      approvalSnapshotId: confirmed.approvalSnapshotId,
      productId,
      result: {
        fetchDetailId: "fetch-late",
        skippedDetailId: null,
        canonicalSuccessDetailId: "detail-late",
        detail: {
          detailId: "detail-late",
          sourceItemId: "abc" as never,
          sourceUrl: "https://detail.1688.com/offer/abc.html",
          title: "Source",
          itemNumber: null,
          description: "",
          category: null,
          sourcePriceWire: null,
          sourceStock: null,
          weightKg: null,
          dimensionsCm: null,
          mainImages: [],
          detailImages: [],
          sourceAttributes: [],
          saleAttributes: [],
          colors: [],
          sizes: [],
          skus: []
        }
      }
    }, {
      jobId: claimed!.jobId,
      owner: "worker-prepare",
      leaseToken: claimed!.leaseToken
    });
    expect(bound).toBe(true);
    const transitioned = await handle.pool.query(
      `SELECT
         (SELECT canonical_success_detail_id FROM products WHERE id = $1) AS product_detail_id,
         (SELECT canonical_success_detail_id FROM approval_snapshots WHERE id = $2) AS approval_detail_id,
         (SELECT count(*)::integer FROM jobs
          WHERE kind = 'miaoshou_edit' AND payload->>'approvalSnapshotId' = $2) AS edit_jobs`,
      [productId, confirmed.approvalSnapshotId]
    );
    expect(transitioned.rows[0]).toEqual({
      product_detail_id: "detail-late",
      approval_detail_id: "detail-late",
      edit_jobs: 1
    });
  });

  test("rejects stale confirmation with conflict metadata and no writes", async () => {
    const { productId } = await readyApprovalFixture();
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 2,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    };
    await expect(approvals.confirmAndEnqueue(command)).rejects.toMatchObject({
      code: "approval_conflict",
      metadata: expect.objectContaining({ field: "templateVersion", expected: 2, actual: 3 })
    });
    const rows = await handle.pool.query("SELECT (SELECT count(*) FROM approval_snapshots)::int AS snapshots, (SELECT count(*) FROM jobs WHERE kind = 'miaoshou_edit')::int AS jobs");
    expect(rows.rows[0]).toEqual({ snapshots: 0, jobs: 0 });
  });

  test("persists result_unknown and only applied reconciliation can finish the sync", async () => {
    const { productId } = await readyApprovalFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    });
    const snapshot = await approvals.loadSnapshot(confirmed.approvalSnapshotId);
    expect(snapshot.priceWire).toBeNull();
    expect(snapshot.skus[0]?.priceWire).toBeUndefined();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.attributes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.priceWire)).toBe(true);
    expect(Object.isFrozen(snapshot.dimensions)).toBe(true);
    expect(Object.isFrozen(snapshot.skus[0])).toBe(true);
    expect(Object.isFrozen(snapshot.skus[0]?.attributes)).toBe(true);
    expect(Object.isFrozen(snapshot.skus[0]?.assetIds)).toBe(true);
    expect(() => { (snapshot.attributes[0] as { value: string }).value = "polyester"; }).toThrow();
    expect(() => { (snapshot.priceWire as { amountMinor: string }).amountMinor = "1"; }).toThrow();
    expect(() => { (snapshot.dimensions as { lengthCm: string }).lengthCm = "1"; }).toThrow();
    expect(() => { (snapshot.skus[0]!.attributes as { color: string }).color = "blue"; }).toThrow();

    const firstClaim = await jobs.claim("worker-first", new Date(), 30_000);
    expect(firstClaim).not.toBeNull();
    const firstFence = { jobId: firstClaim!.jobId, owner: "worker-first", leaseToken: firstClaim!.leaseToken };
    expect(await approvals.saveResultUnknown(confirmed.approvalSnapshotId, {
      kind: "reconcile_required",
      code: "timeout",
      safeMessage: "result unknown"
    }, firstFence)).toBe(true);
    expect(await jobs.markResultUnknown(firstClaim!.jobId, "worker-first", firstClaim!.leaseToken, new Date(), "remote-task-1", {
      kind: "reconcile_required",
      code: "reconcile_required",
      safeMessage: "reconcile before retry"
    })).toBe(true);

    const reconcileClaim = await jobs.claimReconciliation("worker-reconcile", new Date(), 30_000);
    expect(reconcileClaim?.jobId).toBe(firstClaim!.jobId);
    const reconcileFence = { jobId: reconcileClaim!.jobId, owner: "worker-reconcile", leaseToken: reconcileClaim!.leaseToken };
    expect(await approvals.saveReconciled(confirmed.approvalSnapshotId, {
      remoteDetailId: "detail-canonical",
      state: "no_change"
    }, reconcileFence)).toBe(false);
    expect(await approvals.saveReconciliationResultUnknown(confirmed.approvalSnapshotId, {
      remoteDetailId: "detail-canonical",
      state: "no_change"
    }, reconcileFence)).toBe(true);
    const resultUnknown = await handle.pool.query(
      "SELECT error FROM miaoshou_syncs WHERE id = $1",
      [confirmed.syncId]
    );
    expect(resultUnknown.rows[0]?.error).toMatchObject({
      code: "miaoshou_reconcile_no_change",
      initialFailure: { code: "timeout", safeMessage: "result unknown" },
      reconciliation: { state: "no_change", remoteDetailId: "detail-canonical" }
    });
    expect(await approvals.saveReconciled(confirmed.approvalSnapshotId, {
      remoteDetailId: "detail-canonical",
      state: "applied"
    }, reconcileFence)).toBe(true);
    const sync = await handle.pool.query(
      "SELECT state, remote_detail_id, last_reconciled_at, error FROM miaoshou_syncs WHERE id = $1",
      [confirmed.syncId]
    );
    expect(sync.rows[0]).toMatchObject({ state: "succeeded", remote_detail_id: "detail-canonical", error: null });
    expect(sync.rows[0].last_reconciled_at).not.toBeNull();
  });

  test("creates exactly one marker-free manual retry after explicit no_change reconciliation", async () => {
    const { productId } = await readyApprovalFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    });
    await handle.pool.query(
      `UPDATE miaoshou_syncs
       SET state = 'result_unknown',
           error = '{"kind":"reconcile_required","code":"miaoshou_reconcile_no_change","safeMessage":"remote unchanged"}'::jsonb
       WHERE approval_snapshot_id = $1`,
      [confirmed.approvalSnapshotId]
    );
    await handle.pool.query(
      `UPDATE jobs
       SET status = 'needs_input', remote_task_id = 'canonical:detail-canonical:ctx:test',
           error = '{"kind":"reconcile_required","code":"reconcile_failed","safeMessage":"reconcile before retry"}'::jsonb
       WHERE kind = 'miaoshou_edit' AND payload->>'approvalSnapshotId' = $1`,
      [confirmed.approvalSnapshotId]
    );

    const first = await approvals.retryMiaoshouEditAfterNoChange(productId);
    const second = await approvals.retryMiaoshouEditAfterNoChange(productId);

    expect(second).toEqual(first);
    const result = await handle.pool.query(
      `SELECT id, business_key, payload, status, remote_task_id
       FROM jobs
       WHERE kind = 'miaoshou_edit' AND payload->>'approvalSnapshotId' = $1
       ORDER BY created_at ASC, id ASC`,
      [confirmed.approvalSnapshotId]
    );
    expect(result.rows).toHaveLength(2);
    expect(result.rows[1]).toMatchObject({
      id: first.jobId,
      business_key: expect.stringContaining(":manual-retry:1"),
      payload: expect.objectContaining({ approvalSnapshotId: confirmed.approvalSnapshotId, productId }),
      status: "queued",
      remote_task_id: null
    });
    const state = await handle.pool.query(
      `SELECT
         (SELECT state FROM miaoshou_syncs WHERE approval_snapshot_id = $1) AS sync,
         (SELECT state_miaoshou_edit FROM products WHERE id = $2) AS product,
         (SELECT count(*)::integer FROM audit_events WHERE action = 'miaoshou.edit.manual_retry_queued') AS audits`,
      [confirmed.approvalSnapshotId, productId]
    );
    expect(state.rows[0]).toEqual({ sync: "queued", product: "queued", audits: 1 });
  });

  test("rejects manual retry when result_unknown has no explicit no_change evidence", async () => {
    const { productId } = await readyApprovalFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    });
    await handle.pool.query(
      `UPDATE miaoshou_syncs
       SET state = 'result_unknown',
           error = '{"kind":"reconcile_required","code":"miaoshou.network","safeMessage":"unknown"}'::jsonb
       WHERE approval_snapshot_id = $1`,
      [confirmed.approvalSnapshotId]
    );

    await expect(approvals.retryMiaoshouEditAfterNoChange(productId)).rejects.toMatchObject({
      code: "retry_not_allowed"
    });
  });

  test("does not reuse an idempotent approval when persisted material changed under the same run ids", async () => {
    const { productId } = await readyApprovalFixture();
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    };
    await approvals.confirmAndEnqueue(command);
    await handle.pool.query("UPDATE listing_drafts SET title = 'Changed title' WHERE id = 'run-listing-1'");

    await expect(approvals.confirmAndEnqueue(command)).rejects.toMatchObject({
      code: "approval_conflict",
      metadata: expect.objectContaining({ field: "title", expected: "Thai title", actual: "Changed title" })
    });
    const counts = await handle.pool.query("SELECT (SELECT count(*) FROM approval_snapshots)::int AS snapshots, (SELECT count(*) FROM jobs WHERE kind = 'miaoshou_edit')::int AS jobs");
    expect(counts.rows[0]).toEqual({ snapshots: 1, jobs: 1 });
  });

  test("transactionally invalidates the current approval and queued edit exactly once", async () => {
    const { productId } = await readyApprovalFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    });

    expect(await approvals.invalidateCurrentApproval(productId, "title_changed")).toBe(true);
    expect(await approvals.invalidateCurrentApproval(productId, "title_changed")).toBe(false);
    await expect(approvals.loadSnapshot(confirmed.approvalSnapshotId)).rejects.toThrow(/not active/i);
    const state = await handle.pool.query(
      `SELECT
         (SELECT state FROM approval_snapshots WHERE id = $1) AS approval,
         (SELECT state_approval FROM products WHERE id = $2) AS product,
         (SELECT status FROM jobs WHERE payload->>'approvalSnapshotId' = $1) AS job`,
      [confirmed.approvalSnapshotId, productId]
    );
    expect(state.rows[0]).toEqual({ approval: "invalidated", product: "unapproved", job: "failed" });
  });

  test("rejects invalidation while the corresponding Miaoshou edit job is running", async () => {
    const { productId } = await readyApprovalFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1, productId, expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3, orderedFinalAssetIds: ["asset-a", "asset-b"]
    });
    const claimed = await jobs.claim("sync-worker", new Date(), 30_000);
    expect(claimed).not.toBeNull();

    await expect(approvals.invalidateCurrentApproval(productId, "title_changed")).rejects.toMatchObject({
      code: "approval_sync_in_progress"
    });
    const state = await handle.pool.query(
      `SELECT
         (SELECT state FROM approval_snapshots WHERE id = $1) AS approval,
         (SELECT state FROM miaoshou_syncs WHERE approval_snapshot_id = $1) AS sync,
         (SELECT status FROM jobs WHERE id = $2) AS job`,
      [confirmed.approvalSnapshotId, claimed!.jobId]
    );
    expect(state.rows[0]).toEqual({ approval: "approved", sync: "queued", job: "running" });
  });

  test.each(["syncing", "result_unknown"])(
    "rejects invalidation while Miaoshou sync state is %s",
    async (syncState) => {
      const { productId } = await readyApprovalFixture();
      const confirmed = await approvals.confirmAndEnqueue({
        version: 1, productId, expectedDraftVersion: 1,
        expectedListingRunId: "run-listing-1",
        expectedTemplateVersion: 3, orderedFinalAssetIds: ["asset-a", "asset-b"]
      });
      await handle.pool.query(
        "UPDATE miaoshou_syncs SET state = $2 WHERE approval_snapshot_id = $1",
        [confirmed.approvalSnapshotId, syncState]
      );

      await expect(approvals.invalidateCurrentApproval(productId, "image_order_changed")).rejects.toMatchObject({
        code: "approval_sync_in_progress"
      });
      expect((await handle.pool.query("SELECT state FROM approval_snapshots WHERE id = $1", [confirmed.approvalSnapshotId])).rows[0]?.state).toBe("approved");
    }
  );

  test("atomically cancels a paused edit before invalidating approval", async () => {
    const { productId } = await readyApprovalFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1, productId, expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3, orderedFinalAssetIds: ["asset-a", "asset-b"]
    });
    await handle.pool.query(
      "UPDATE jobs SET status = 'paused', pause_reason = 'operator' WHERE payload->>'approvalSnapshotId' = $1",
      [confirmed.approvalSnapshotId]
    );

    expect(await approvals.invalidateCurrentApproval(productId, "price_changed")).toBe(true);
    expect((await handle.pool.query("SELECT status FROM jobs WHERE payload->>'approvalSnapshotId' = $1", [confirmed.approvalSnapshotId])).rows[0]?.status).toBe("failed");
  });

  test("running sync persistence and invalidation share lock order without deadlock or stale invalidation", async () => {
    const { productId } = await readyApprovalFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1, productId, expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedTemplateVersion: 3, orderedFinalAssetIds: ["asset-a", "asset-b"]
    });
    const claimed = await jobs.claim("concurrent-sync-worker", new Date(), 30_000);
    expect(claimed).not.toBeNull();
    const fence = { jobId: claimed!.jobId, owner: "concurrent-sync-worker", leaseToken: claimed!.leaseToken };

    const [saved, invalidated] = await Promise.allSettled([
      approvals.saveSucceeded(confirmed.approvalSnapshotId, "detail-canonical", fence),
      approvals.invalidateCurrentApproval(productId, "title_changed")
    ]);

    expect(saved).toEqual({ status: "fulfilled", value: true });
    expect(invalidated.status).toBe("rejected");
    if (invalidated.status === "rejected") expect(invalidated.reason).toMatchObject({ code: "approval_sync_in_progress" });
    const state = await handle.pool.query(
      `SELECT
         (SELECT state FROM approval_snapshots WHERE id = $1) AS approval,
         (SELECT state FROM miaoshou_syncs WHERE approval_snapshot_id = $1) AS sync`,
      [confirmed.approvalSnapshotId]
    );
    expect(state.rows[0]).toEqual({ approval: "approved", sync: "succeeded" });
  });
});

describe("integration: image generation repository", () => {
  // Helper to count rows in a table filtered by batch_id
  async function countSlotRows(batchId: string): Promise<number> {
    const result = await handle.pool.query(
      "SELECT count(*)::integer AS count FROM image_generation_slots WHERE batch_id = $1",
      [batchId]
    );
    return result.rows[0]?.count ?? 0;
  }

  // Helper to count jobs of a specific kind for a batch
  async function countPlannerJobs(batchId: string): Promise<number> {
    const result = await handle.pool.query(
      "SELECT count(*)::integer AS count FROM jobs WHERE batch_key = $1 AND kind = 'image_prompt_plan'",
      [batchId]
    );
    return result.rows[0]?.count ?? 0;
  }

  // Fixture: minimal template + version + assets for image generation tests
  async function fixtureTemplate(): Promise<{ templateId: string; versionId: string }> {
    const templateId = newId("tmpl");
    const versionId = newId("tv");
    await handle.pool.query(
      `INSERT INTO image_generation_templates
       (id, name, category_key, enabled, created_at, updated_at)
       VALUES ($1, 'Test Template', 'dress', true, now(), now())`,
      [templateId]
    );
    await handle.pool.query(
      `INSERT INTO image_generation_template_versions
       (id, template_id, version, lifecycle_state, recipe, created_at)
       VALUES ($1, $2, 1, 'active', $3::jsonb, now())`,
      [versionId, templateId, JSON.stringify({
        version: 1,
        inputCount: 3,
        outputCount: 3,
        mustPreserve: ["product identity"],
        visualDirection: "marketplace product photography",
        forbidden: ["brand logos"],
        roles: [
          { key: "primary", instruction: "front-facing hero image" },
          { key: "detail", instruction: "material detail image" },
          { key: "lifestyle", instruction: "realistic usage scene" }
        ],
        providerParameters: {}
      })]
    );
    await handle.pool.query(
      `UPDATE image_generation_templates SET active_version_id = $1 WHERE id = $2`,
      [versionId, templateId]
    );
    return { templateId, versionId };
  }

  // Fixture: archived asset for markSlotSucceeded
  function _fixtureArchivedAsset(assetId: string) {
    return assetId;
  }

  // Fixture: failure for markSlotFailed
  function _safeFailure(code: string) {
    return { kind: "retryable" as const, code, safeMessage: "test failure" };
  }

  // Fixture: createBatch input
  async function fixtureStart(overrides: {
    idempotencyKey?: string;
    outputCount?: number;
    templateId?: string;
    versionId?: string;
  } = {}): Promise<Parameters<typeof imageGen.createBatch>[0]> {
    const { templateId, versionId } = overrides.templateId && overrides.versionId
      ? { templateId: overrides.templateId, versionId: overrides.versionId }
      : await fixtureTemplate();

    const opId = await catalog.upsertLocalOperator({ handle: "img-op", displayName: "Image Gen Op" });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/img.html",
      locale: "th-TH",
      currency: "THB"
    });
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "Image Gen Product",
      workingDraft: {}
    });

    // Create ready assets
    const assetIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const assetId = newId(`ast${i}`);
      await handle.pool.query(
        `INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, local_path, extension)
         VALUES ($1, $2, $3, $4, 'detail', 'ready', '/assets/asset.png', 'png')`,
        [assetId, productId, revisionId, `https://cdn.test/asset${i}.jpg`]
      );
      assetIds.push(assetId);
    }

    return {
      idempotencyKey: overrides.idempotencyKey ?? `start:rev_1:${newId("idem")}`,
      productId,
      revisionId,
      selectedAssetIds: assetIds.slice(0, 3),
      requestedOutputCount: overrides.outputCount ?? 3,
      categoryKey: "dress",
      templateId: overrides.templateId ?? templateId,
      templateVersionId: overrides.versionId ?? versionId,
      templateVersion: 1,
      recipe: {
        version: 1 as const,
        inputCount: 3,
        outputCount: 3,
        mustPreserve: ["product identity"],
        visualDirection: "marketplace product photography",
        forbidden: ["brand logos"],
        roles: [
          { key: "primary", instruction: "front-facing hero image" },
          { key: "detail", instruction: "material detail image" },
          { key: "lifestyle", instruction: "realistic usage scene" }
        ],
        providerParameters: {}
      },
      productFacts: { title: "Test Product", category: "dress" },
      productFactsDigest: "abc123"
    };
  }

  async function claimPlanner(batchId: string) {
    const planner = (await handle.pool.query(
      "SELECT id FROM jobs WHERE batch_key = $1 AND kind = 'image_prompt_plan'",
      [batchId]
    )).rows[0]!;
    const fence = { jobId: String(planner.id), owner: "planner-worker", leaseToken: newId("lease") };
    await handle.pool.query(
      `UPDATE jobs SET status = 'running', owner = $2, lease_token = $3,
         lease_expires_at = now() + interval '5 minutes' WHERE id = $1`,
      [fence.jobId, fence.owner, fence.leaseToken]
    );
    return fence;
  }

  test("creates batch, planner job, and requested slots atomically and idempotently", async () => {
    const input = await fixtureStart({ idempotencyKey: `start:rev_1:abc${newId("idem")}`, outputCount: 3 });
    const first = await imageGen.createBatch(input);
    const second = await imageGen.createBatch({ ...input, idempotencyKey: input.idempotencyKey });

    expect(second.batchId).toBe(first.batchId);
    expect(await countSlotRows(first.batchId)).toBe(3);
    expect(await countPlannerJobs(first.batchId)).toBe(1);
    const context = await imageGen.loadPlanningContext(first.batchId);
    expect(context?.references).toEqual(input.selectedAssetIds.map((assetId) => ({
      assetId,
      localPath: "/assets/asset.png",
      extension: "png"
    })));
    expect((await handle.pool.query(
      "SELECT role FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number",
      [first.batchId]
    )).rows.map((row) => row.role)).toEqual(["primary", "detail", "lifestyle"]);
  });

  test("rejects an expired planner lease before prompts or slot jobs are written", async () => {
    const input = await fixtureStart({ idempotencyKey: `start:planner-fence:${newId("idem")}`, outputCount: 1 });
    const { batchId } = await imageGen.createBatch(input);
    const fence = await claimPlanner(batchId);
    await handle.pool.query(
      "UPDATE jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [fence.jobId]
    );

    await expect(imageGen.savePlanAndQueueSlots(batchId, {
      prompts: [{
        slot: 1,
        role: "primary",
        prompt: "must not be persisted",
        mustPreserve: [],
        forbidden: []
      }]
    }, fence)).rejects.toMatchObject({ code: "lease_fence_lost" });

    expect((await handle.pool.query(
      "SELECT state, prompt FROM image_generation_slots WHERE batch_id = $1",
      [batchId]
    )).rows).toEqual([expect.objectContaining({ state: "waiting_for_plan", prompt: null })]);
    expect((await handle.pool.query(
      "SELECT count(*)::integer AS count FROM jobs WHERE batch_key = $1 AND kind = 'image_generate_slot'",
      [batchId]
    )).rows[0]?.count).toBe(0);
  });

  test("atomically creates a ready generated asset and stores its id on the fenced slot", async () => {
    const input = await fixtureStart({ idempotencyKey: `start:archive:${newId("idem")}`, outputCount: 1 });
    const { batchId } = await imageGen.createBatch(input);
    const slot = (await handle.pool.query(
      "SELECT id, slot_number, role FROM image_generation_slots WHERE batch_id = $1",
      [batchId]
    )).rows[0]!;
    await imageGen.savePlanAndQueueSlots(batchId, {
      prompts: [{
        slot: Number(slot.slot_number),
        role: String(slot.role),
        prompt: "archive this generated image",
        mustPreserve: [],
        forbidden: []
      }]
    }, await claimPlanner(batchId));
    const job = (await handle.pool.query(
      "SELECT id FROM jobs WHERE batch_key = $1 AND kind = 'image_generate_slot'",
      [batchId]
    )).rows[0]!;
    const fence = { jobId: String(job.id), owner: "archive-worker", leaseToken: newId("lease") };
    await handle.pool.query(
      `UPDATE jobs SET status = 'running', owner = $2, lease_token = $3,
         lease_expires_at = now() + interval '5 minutes' WHERE id = $1`,
      [fence.jobId, fence.owner, fence.leaseToken]
    );

    const assetId = await imageGen.archiveSlotOutput(String(slot.id), {
      remoteUrl: "https://provider.test/generated.png",
      finalUrl: "https://cdn.provider.test/generated.png",
      sha256: "a".repeat(64),
      path: "/data/assets/aa/generated.png",
      extension: "png",
      bytes: 4096,
      width: 1024,
      height: 1024
    }, fence);

    expect(assetId).toMatch(/^asset_/);
    const persisted = await handle.pool.query(
      `SELECT s.state, s.archived_asset_id, a.product_id, a.revision_id,
              a.state AS asset_state, a.remote_url, a.local_path, a.extension,
              a.sha256, a.width, a.height
       FROM image_generation_slots s
       JOIN assets a ON a.id = s.archived_asset_id
       WHERE s.id = $1`,
      [slot.id]
    );
    expect(persisted.rows[0]).toMatchObject({
      state: "succeeded",
      archived_asset_id: assetId,
      product_id: input.productId,
      revision_id: input.revisionId,
      asset_state: "ready",
      remote_url: "https://provider.test/generated.png",
      local_path: "/data/assets/aa/generated.png",
      extension: "png",
      sha256: "a".repeat(64),
      width: 1024,
      height: 1024
    });
    expect(persisted.rows[0]?.archived_asset_id).not.toBe("/data/assets/aa/generated.png");
  });

  test("retries slot four with a versioned payload that preserves slot number and increments attempt", async () => {
    const input = await fixtureStart({ idempotencyKey: `start:retry:${newId("idem")}`, outputCount: 4 });
    const { batchId } = await imageGen.createBatch(input);
    const slot = (await handle.pool.query(
      "SELECT id FROM image_generation_slots WHERE batch_id = $1 AND slot_number = 4",
      [batchId]
    )).rows[0]!;
    await handle.pool.query(
      "UPDATE image_generation_slots SET state = 'failed', error = '{}'::jsonb WHERE id = $1",
      [slot.id]
    );

    expect(await imageGen.retrySlot(String(slot.id))).toBe(true);
    const retried = await handle.pool.query(
      `SELECT s.attempt, j.payload
       FROM image_generation_slots s
       JOIN jobs j ON j.batch_key = s.batch_id AND j.kind = 'image_generate_slot'
       WHERE s.id = $1 AND (j.payload->>'attempt')::integer = 1`,
      [slot.id]
    );
    expect(retried.rows[0]).toMatchObject({
      attempt: 1,
      payload: { version: 1, batchId, slotId: slot.id, slotNumber: 4, attempt: 1 }
    });
  });

  test("rejects a ready asset owned by another product revision inside batch creation", async () => {
    const input = await fixtureStart({ idempotencyKey: `start:foreign:${newId("idem")}` });
    const otherProductId = await catalog.insertProduct({
      operatorId: await catalog.upsertLocalOperator({ handle: "img-other-op", displayName: "Other Image Op" }),
      sourceUrl: "https://detail.1688.com/offer/other-img.html",
      locale: "th-TH",
      currency: "THB"
    });
    const otherRevisionId = await catalog.insertRevision({
      productId: otherProductId,
      draftVersion: 1,
      sourceTitle: "Other Product",
      workingDraft: {}
    });
    const foreignAssetId = newId("foreign_asset");
    await handle.pool.query(
      `INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, local_path, extension)
       VALUES ($1, $2, $3, 'https://cdn.test/foreign.png', 'main', 'ready', '/assets/foreign.png', 'png')`,
      [foreignAssetId, otherProductId, otherRevisionId]
    );

    await expect(imageGen.createBatch({
      ...input,
      selectedAssetIds: [foreignAssetId]
    })).rejects.toMatchObject({ code: "asset_not_in_revision" });

    expect((await handle.pool.query(
      "SELECT count(*)::integer AS count FROM image_generation_batches WHERE idempotency_key = $1",
      [input.idempotencyKey]
    )).rows[0]?.count).toBe(0);
  });

  test("keeps successful siblings unchanged when one slot fails", async () => {
    const input = await fixtureStart({ idempotencyKey: `start:rev_1:sibs${newId("idem")}`, outputCount: 3 });
    const { batchId } = await imageGen.createBatch(input);

    // First, save plan to move slots from waiting_for_plan to queued
    const slotsBefore = await handle.pool.query(
      "SELECT id, slot_number, role FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number",
      [batchId]
    );
    const plannedPrompts = slotsBefore.rows.map((s) => ({
      slot: Number(s.slot_number),
      role: String(s.role),
      prompt: "test prompt for " + s.role,
      mustPreserve: [] as string[],
      forbidden: [] as string[]
    }));
    await imageGen.savePlanAndQueueSlots(batchId, { prompts: plannedPrompts }, await claimPlanner(batchId));

    // Create a real archived asset for the succeeded slot
    const succeededAssetId = newId("succeeded_asset");
    await handle.pool.query(
      `INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, local_path, extension)
       VALUES ($1, $2, $3, 'https://cdn.test/succeeded.jpg', 'generated', 'ready', '/assets/succeeded.jpg', 'jpg')`,
      [succeededAssetId, input.productId, input.revisionId]
    );

    // Simulate: slot_1 succeeded, slot_2 failed, slot_3 still queued
    const slots = await handle.pool.query(
      "SELECT id, slot_number FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number",
      [batchId]
    );
    const [slot1, slot2, _slot3] = slots.rows;

    // Mark slot 1 succeeded
    await handle.pool.query(
      `UPDATE image_generation_slots SET state = 'succeeded', archived_asset_id = $1, updated_at = now()
       WHERE id = $2`,
      [succeededAssetId, slot1.id]
    );

    // Mark slot 2 failed
    await handle.pool.query(
      `UPDATE image_generation_slots SET state = 'failed', error = $1::jsonb, updated_at = now()
       WHERE id = $2`,
      [JSON.stringify({ kind: "retryable", code: "provider_timeout", safeMessage: "timeout" }), slot2.id]
    );

    // slot3 stays in 'queued' state

    const projection = await imageGen.getProductProjection(input.productId);
    expect(projection).not.toBeNull();
    expect(projection!.slots.map((s) => s.state)).toEqual(["succeeded", "failed", "queued"]);
  });

  test("accepting generated slots makes the exact ordered assets approval-ready", async () => {
    const input = await fixtureStart({
      idempotencyKey: `start:accept-ready:${newId("idem")}`,
      outputCount: 2
    });
    const { batchId } = await imageGen.createBatch(input);
    const slots = await handle.pool.query<{ id: string }>(
      "SELECT id FROM image_generation_slots WHERE batch_id = $1 ORDER BY slot_number",
      [batchId]
    );
    const assetIds = [newId("accepted_asset"), newId("accepted_asset")];
    for (let index = 0; index < assetIds.length; index++) {
      await handle.pool.query(
        `INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, local_path, extension)
         VALUES ($1, $2, $3, $4, 'generated', 'ready', $5, 'png')`,
        [assetIds[index], input.productId, input.revisionId, `https://cdn.test/accepted-${index}.png`, `/assets/accepted-${index}.png`]
      );
      await handle.pool.query(
        "UPDATE image_generation_slots SET state = 'succeeded', archived_asset_id = $1 WHERE id = $2",
        [assetIds[index], slots.rows[index]!.id]
      );
    }

    const acceptedOrder = [assetIds[1]!, assetIds[0]!];
    await imageGen.acceptPartial(batchId, acceptedOrder);

    const state = await handle.pool.query<{ state_automation: string; working_draft: Record<string, unknown> }>(
      `SELECT product.state_automation, revision.working_draft
       FROM products product
       JOIN product_revisions revision ON revision.product_id = product.id
       WHERE revision.id = $1`,
      [input.revisionId]
    );
    expect(state.rows[0]?.state_automation).toBe("ready");
    expect(state.rows[0]?.working_draft.finalAssetOrder).toEqual(acceptedOrder);
  });
});

// T13 fix: every accepted assetId must come from a succeeded, archived, not-excluded slot.
// Pin spec gap A and B in a single suite so they can be moved to a unit file later if needed.
describe("integration: ApprovalRepository T13 acceptance wiring", () => {
  async function slotFixture(): Promise<{
    productId: string;
    revisionId: string;
    batchId: string;
    assetA: string;
    assetB: string;
    slotAId: string;
    slotBId: string;
    templateVersionId: string;
  }> {
    const opId = await catalog.upsertLocalOperator({
      handle: "slot-approval-op",
      displayName: "Slot Approval Op"
    });
    const productId = await catalog.insertProduct({
      operatorId: opId,
      sourceUrl: "https://detail.1688.com/offer/slots.html",
      sourceItemId: "slot-1",
      locale: "th-TH",
      currency: "THB"
    });
    await handle.pool.query(
      `UPDATE products
       SET state_automation = 'ready', state_source = 'success',
           canonical_success_detail_id = 'detail-slot-canonical'
       WHERE id = $1`,
      [productId]
    );
    const revisionId = await catalog.insertRevision({
      productId,
      draftVersion: 1,
      sourceTitle: "Slot Approval Source",
      workingDraft: {
        listingRunId: "run-listing-slots",
        pricingRunId: "run-pricing-slots",
        templateMatch: { templateId: "slot-template", templateVersion: 1 },
        finalAssetOrder: ["slot-asset-a", "slot-asset-b"]
      }
    });
    await handle.pool.query(
      "UPDATE product_revisions SET source_payload = $2::jsonb WHERE id = $1",
      [revisionId, JSON.stringify({
        sourceItemId: "slot-1",
        itemNumber: "ITEM-SLOT-1",
        skus: []
      })]
    );
    await handle.pool.query(
      `INSERT INTO listing_drafts
        (id, product_id, revision_id, draft_version, target_locale, style, title, description, attributes)
       VALUES ('run-listing-slots', $1, $2, 1, 'th-TH', 'neutral', 'Slot Title', 'Slot description', '[]'::jsonb)`,
      [productId, revisionId]
    );

    // Create a template + active version so batches reference real rows.
    const templateId = newId("tmpl");
    const templateVersionId = newId("tv");
    await handle.pool.query(
      `INSERT INTO image_generation_templates (id, name, category_key, enabled, created_at, updated_at)
       VALUES ($1, 'Slot Template', 'dress', true, now(), now())`,
      [templateId]
    );
    await handle.pool.query(
      `INSERT INTO image_generation_template_versions (id, template_id, version, lifecycle_state, recipe, created_at)
       VALUES ($1, $2, 1, 'active', $3::jsonb, now())`,
      [templateVersionId, templateId, JSON.stringify({ version: 1, inputCount: 1, outputCount: 2, roles: ["primary", "detail"] })]
    );
    await handle.pool.query(
      `UPDATE image_generation_templates SET active_version_id = $1 WHERE id = $2`,
      [templateVersionId, templateId]
    );

    // Batch + succeeded slot rows that reference archived assets.
    const batchId = newId("batch");
    await handle.pool.query(
      `INSERT INTO image_generation_batches
        (id, product_id, revision_id, idempotency_key, selected_asset_ids, requested_output_count,
         category_key, template_id, template_version_id, template_version, recipe_snapshot,
         product_facts_snapshot, product_facts_digest, state)
       VALUES ($1, $2, $3, $4, '[]'::jsonb, 2, 'dress', $5, $6, 1, '{}'::jsonb, '{}'::jsonb, 'digest', 'succeeded')`,
      [batchId, productId, revisionId, `slot-key-${newId("idem")}`, templateId, templateVersionId]
    );

    const assetA = "slot-asset-a";
    const assetB = "slot-asset-b";
    await handle.pool.query(
      `INSERT INTO assets (id, product_id, revision_id, remote_url, kind, state, local_path, extension, sha256)
       VALUES
         ($1, $2, $3, 'https://source.test/a.jpg', 'generated', 'ready', '/assets/slot-a.png', 'png', 'sha-a'),
         ($4, $2, $3, 'https://source.test/b.jpg', 'generated', 'ready', '/assets/slot-b.png', 'png', 'sha-b')`,
      [assetA, productId, revisionId, assetB]
    );

    const slotAId = newId("slot");
    const slotBId = newId("slot");
    await handle.pool.query(
      `INSERT INTO image_generation_slots
        (id, batch_id, slot_number, role, state, archived_asset_id)
       VALUES
         ($1, $2, 1, 'primary', 'succeeded', $3),
         ($4, $2, 2, 'detail', 'succeeded', $5)`,
      [slotAId, batchId, assetA, slotBId, assetB]
    );

    return { productId, revisionId, batchId, assetA, assetB, slotAId, slotBId, templateVersionId };
  }

  test("rejects confirmation when an accepted asset has no succeeded slot", async () => {
    const fixture = await slotFixture();
    // Demote slot B to failed: the asset is "ready" but no slot produced it.
    await handle.pool.query(
      "UPDATE image_generation_slots SET state = 'failed', archived_asset_id = NULL WHERE id = $1",
      [fixture.slotBId]
    );

    await expect(
      approvals.confirmAndEnqueue({
        version: 1,
        productId: fixture.productId,
        expectedDraftVersion: 1,
        expectedListingRunId: "run-listing-slots",
        expectedTemplateVersion: 1,
        orderedFinalAssetIds: [fixture.assetA, fixture.assetB]
      })
    ).rejects.toMatchObject({
      code: "approval_conflict",
      metadata: expect.objectContaining({ field: "orderedFinalAssetIds" })
    });
    const rows = await handle.pool.query("SELECT count(*)::integer AS count FROM approval_snapshots");
    expect(rows.rows[0].count).toBe(0);
  });

  test("rejects confirmation when an accepted slot is excluded", async () => {
    const fixture = await slotFixture();
    await handle.pool.query(
      "UPDATE image_generation_slots SET excluded_at = now() WHERE id = $1",
      [fixture.slotAId]
    );
    await expect(
      approvals.confirmAndEnqueue({
        version: 1,
        productId: fixture.productId,
        expectedDraftVersion: 1,
        expectedListingRunId: "run-listing-slots",
        expectedTemplateVersion: 1,
        orderedFinalAssetIds: [fixture.assetA, fixture.assetB]
      })
    ).rejects.toMatchObject({
      code: "approval_conflict",
      metadata: expect.objectContaining({ field: "orderedFinalAssetIds" })
    });
  });

  test("accepts a confirmation where every asset is produced by a succeeded, archived, non-excluded slot", async () => {
    const fixture = await slotFixture();
    const result = await approvals.confirmAndEnqueue({
      version: 1,
      productId: fixture.productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-slots",
      expectedTemplateVersion: 1,
      orderedFinalAssetIds: [fixture.assetA, fixture.assetB]
    });
    expect(result.approvalSnapshotId).toMatch(/^approval_/);
  });

  test("keeps completed legacy Canvas outputs eligible for approval", async () => {
    const fixture = await slotFixture();
    await handle.pool.query("DELETE FROM image_generation_slots WHERE batch_id = $1", [fixture.batchId]);
    await handle.pool.query(
      `INSERT INTO canvas_runs
         (id, product_id, revision_id, template_id, template_version, state, outputs)
       VALUES ($1, $2, $3, 'legacy-canvas-template', 1, 'succeeded', $4::jsonb)`,
      [newId("canvas"), fixture.productId, fixture.revisionId, JSON.stringify([fixture.assetA, fixture.assetB])]
    );

    const result = await approvals.confirmAndEnqueue({
      version: 1,
      productId: fixture.productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-slots",
      expectedTemplateVersion: 1,
      orderedFinalAssetIds: [fixture.assetA, fixture.assetB]
    });
    expect(result.approvalSnapshotId).toMatch(/^approval_/);
  });

  test("loadSnapshot exposes sha256 and extension in asset order", async () => {
    const fixture = await slotFixture();
    const confirmed = await approvals.confirmAndEnqueue({
      version: 1,
      productId: fixture.productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-slots",
      expectedTemplateVersion: 1,
      orderedFinalAssetIds: [fixture.assetA, fixture.assetB]
    });
    const snapshot = await approvals.loadSnapshot(confirmed.approvalSnapshotId);
    expect(snapshot.orderedFinalAssetIds).toEqual([fixture.assetA, fixture.assetB]);
    expect(snapshot.orderedFinalAssetLocalPaths).toEqual(["/assets/slot-a.png", "/assets/slot-b.png"]);
    expect(snapshot.orderedFinalAssetSha256).toEqual(["sha-a", "sha-b"]);
    expect(snapshot.orderedFinalAssetExtension).toEqual(["png", "png"]);
  });
});
