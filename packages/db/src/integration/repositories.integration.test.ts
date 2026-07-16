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
import { JobRepository } from "../repositories/job-repository.js";
import { ExchangeRateRepository } from "../repositories/exchange-rate-repository.js";
import { AutomationRunRepository } from "../repositories/automation-run-repository.js";
import { CanvasQuotaRepository } from "../repositories/canvas-quota-repository.js";
import { AssetRepository } from "../repositories/asset-repository.js";
import { PipelineRepository } from "../repositories/pipeline-repository.js";
import { ApprovalRepository } from "../repositories/approval-repository.js";
import { INITIAL_SQL } from "../migrations/0000_initial.js";

let handle: TestDbHandle;
let catalog: CatalogRepository;
let jobs: JobRepository;
let rates: ExchangeRateRepository;
let automations: AutomationRunRepository;
let approvals: ApprovalRepository;
let canvasQuota: CanvasQuotaRepository;
let assets: AssetRepository;
let pipeline: PipelineRepository;

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
              pricing_defaults, provider_options, retry_policy
       FROM workspace_settings WHERE id = 1`
    );
    expect(settings.rows[0]).toMatchObject({
      default_locale: "vi-VN", worker_concurrency: 7, asset_root: "./legacy-assets", version: "1",
      pricing_defaults: { targetProfitRate: "0.30" },
      provider_options: { canvasWorkflow: "TK工作流" },
      retry_policy: { maxAttempts: 3 }
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

    const unknownWithoutRemoteId = await jobs.enqueue({ kind: "canvas_generate", businessKey: "control:unknown-without-id", payload: { version: 1 } });
    await handle.pool.query("UPDATE jobs SET status = 'needs_input', remote_task_id = NULL, error = '{\"code\":\"reconcile_required\"}'::jsonb WHERE id = $1", [unknownWithoutRemoteId]);
    expect(await jobs.retrySafe(unknownWithoutRemoteId, new Date("2026-07-16T00:00:00Z"))).toBe(false);
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
    for (const kind of ["listing_generate", "exchange_rate_refresh"]) {
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
    expect(queued.rows[0].payload).toEqual({ version: 1, revisionId: revId, remoteUrls: [] });
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
  async function readyApprovalFixture() {
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
    await handle.pool.query("UPDATE products SET canonical_success_detail_id = 'detail-canonical', state_automation = 'ready' WHERE id = $1", [productId]);
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
    return { productId, revisionId };
  }

  test("atomically creates one immutable snapshot, sync and edit job", async () => {
    const { productId, revisionId } = await readyApprovalFixture();
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedPricingRunId: "run-pricing-1",
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
      price_minor: "25900",
      price_currency: "THB",
      weight_kg: "0.35",
      state: "approved"
    });
    expect(snapshots.rows[0].skus[0]).toMatchObject({ skuId: "sku-red", assetIds: ["asset-a"] });
    expect(snapshots.rows[0].skus[0].priceWire).toEqual({ amountMinor: "25900", currency: "THB" });
    expect(syncs.rows[0].count).toBe(1);
    expect(queued.rows[0].count).toBe(1);
  });

  test("rejects stale confirmation with conflict metadata and no writes", async () => {
    const { productId } = await readyApprovalFixture();
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedPricingRunId: "run-pricing-1",
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
      expectedPricingRunId: "run-pricing-1",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-a", "asset-b"]
    });
    const snapshot = await approvals.loadSnapshot(confirmed.approvalSnapshotId);
    expect(snapshot.skus[0]?.priceWire).toEqual({ amountMinor: "25900", currency: "THB" });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.attributes[0])).toBe(true);
    expect(Object.isFrozen(snapshot.priceWire)).toBe(true);
    expect(Object.isFrozen(snapshot.dimensions)).toBe(true);
    expect(Object.isFrozen(snapshot.skus[0])).toBe(true);
    expect(Object.isFrozen(snapshot.skus[0]?.attributes)).toBe(true);
    expect(Object.isFrozen(snapshot.skus[0]?.priceWire)).toBe(true);
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

  test("does not reuse an idempotent approval when persisted material changed under the same run ids", async () => {
    const { productId } = await readyApprovalFixture();
    const command: ConfirmMiaoshouEditV1 = {
      version: 1,
      productId,
      expectedDraftVersion: 1,
      expectedListingRunId: "run-listing-1",
      expectedPricingRunId: "run-pricing-1",
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
      expectedPricingRunId: "run-pricing-1",
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
      expectedListingRunId: "run-listing-1", expectedPricingRunId: "run-pricing-1",
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
        expectedListingRunId: "run-listing-1", expectedPricingRunId: "run-pricing-1",
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
      expectedListingRunId: "run-listing-1", expectedPricingRunId: "run-pricing-1",
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
      expectedListingRunId: "run-listing-1", expectedPricingRunId: "run-pricing-1",
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
