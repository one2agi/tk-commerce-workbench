import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { INITIAL_SQL } from "../../../../../../packages/db/src/migrations/0000_initial.js";

import { createPostHandler as createIngestHandler } from "./ingest-links/route";
import { createPostHandler as createAutomationHandler } from "./automation-runs/route";
import { createGetHandler as createProductsHandler } from "./products/route";
import { createGetHandler as createProductHandler } from "./products/[productId]/route";
import { createGetHandler as createSettingsHandler, createPatchHandler as createSettingsPatchHandler } from "./settings/route";
import { createGetHandler as createTasksHandler } from "./tasks/route";
import { createPostHandler as createTaskActionHandler } from "./tasks/[taskId]/actions/route";
import {
  createGetHandler as createTemplatesHandler,
  createPatchHandler as createTemplatePatchHandler,
  createPostHandler as createTemplatePostHandler
} from "./templates/route";
import { createExtensionTokenVerifier } from "../../../server/auth/extension-token";
import {
  IngestService,
  type IngestJobRepository
} from "../../../server/services/ingest-service";
import {
  AutomationService,
  type AutomationRunRepositoryPort
} from "../../../server/services/automation-service";
import { ProductService } from "../../../server/services/product-service";
import { SettingsService } from "../../../server/services/settings-service";
import { TaskService } from "../../../server/services/task-service";
import { TemplateService } from "../../../server/services/template-service";
import { createServerServices, loadRuntimeConfig } from "../../../server/composition";
import { createHttpApiClient, dispatchStartAutomation } from "../../../lib/api-client";

function jsonRequest(url: string, body: unknown, token = "extension-secret"): Request {
  return new Request(url, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      origin: new URL(url).origin,
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

class MemoryIngestJobs implements IngestJobRepository {
  private readonly jobs = new Map<string, string>();
  readonly audits: Array<Record<string, unknown>> = [];

  async enqueue(input: Parameters<IngestJobRepository["enqueue"]>[0]): Promise<string> {
    const existing = this.jobs.get(input.businessKey);
    if (existing) {
      this.audits.push(input.audit);
      return existing;
    }
    const jobId = `job-${this.jobs.size + 1}`;
    this.jobs.set(input.businessKey, jobId);
    this.audits.push(input.audit);
    return jobId;
  }
}

class MemoryAutomationRuns implements AutomationRunRepositoryPort {
  readonly calls: Array<{ revisionId: string; processingVersion: number }> = [];
  readonly audits: Array<Record<string, unknown>> = [];
  private readonly runIds = new Map<string, string>();

  async createOrReuseAndEnqueue(input: Parameters<AutomationRunRepositoryPort["createOrReuseAndEnqueue"]>[0]) {
    this.calls.push({ revisionId: input.revisionId, processingVersion: input.processingVersion });
    this.audits.push(input.audit);
    const existing = this.runIds.get(input.revisionId);
    if (existing) return { runId: existing, created: false };
    const runId = `run-${this.runIds.size + 1}`;
    this.runIds.set(input.revisionId, runId);
    return { runId, created: true };
  }
}

describe("v1 API integration", () => {
  it("binds Next to loopback even when ALLOW_LAN permits non-loopback dependencies", () => {
    const webRoot = fileURLToPath(new URL("../../../../", import.meta.url));
    const manifest = JSON.parse(readFileSync(new URL("../../../../package.json", import.meta.url), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(manifest.scripts.dev).toContain("scripts/run-next.mjs dev");
    expect(manifest.scripts.start).toContain("scripts/run-next.mjs start");
    const command = [fileURLToPath(new URL("../../../../scripts/run-next.mjs", import.meta.url)), "host"];
    expect(execFileSync(process.execPath, command, { cwd: webRoot, env: { ...process.env, ALLOW_LAN: "false" }, encoding: "utf8" }).trim()).toBe("127.0.0.1");
    expect(execFileSync(process.execPath, command, { cwd: webRoot, env: { ...process.env, ALLOW_LAN: "true" }, encoding: "utf8" }).trim()).toBe("127.0.0.1");
    const argsCommand = [fileURLToPath(new URL("../../../../scripts/run-next.mjs", import.meta.url)), "args", "start"];
    expect(JSON.parse(execFileSync(process.execPath, argsCommand, { cwd: webRoot, encoding: "utf8" }))).toEqual([
      "start", "-H", "127.0.0.1"
    ]);
  });

  it("rejects a Host-spoofed automation mutation without same-origin JSON proof", async () => {
    const repository = new MemoryAutomationRuns();
    const handler = createAutomationHandler({
      service: new AutomationService({ processingVersion: async () => 1 }, repository)
    });
    const response = await handler(new Request("http://127.0.0.1/api/v1/automation-runs", {
      method: "POST",
      headers: { host: "127.0.0.1", "content-type": "application/json" },
      body: JSON.stringify({ version: 1, revisionIds: ["rev-spoofed"] })
    }));

    expect(response.status).toBe(403);
    expect(repository.calls).toHaveLength(0);
  });

  it("rejects a Host-spoofed task mutation without same-origin JSON proof", async () => {
    let actionCalls = 0;
    const taskService = new TaskService({ query: async () => ({ rows: [] }) }, {
      execute: async (command) => command({
        tasks: { act: async () => { actionCalls += 1; return true; } },
        audit: { append: async () => "audit-spoofed" }
      })
    });
    const response = await createTaskActionHandler({ service: taskService })(
      new Request("http://127.0.0.1/api/v1/tasks/job-spoofed/actions", {
        method: "POST",
        headers: { host: "127.0.0.1", "content-type": "application/json" },
        body: JSON.stringify({ action: "retry" })
      }),
      { params: Promise.resolve({ taskId: "job-spoofed" }) }
    );

    expect(response.status).toBe(403);
    expect(actionCalls).toBe(0);
  });

  it("connects the ProductWorkbench HTTP client to the same-origin automation route without exposing a secret", async () => {
    const repository = new MemoryAutomationRuns();
    const route = createAutomationHandler({
      service: new AutomationService({ processingVersion: async () => 1 }, repository)
    });
    let sentAuthorization: string | null = null;
    const browserFetch = async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers);
      sentAuthorization = headers.get("authorization");
      headers.set("origin", "http://127.0.0.1");
      return route(new Request(new URL(String(input), "http://127.0.0.1"), { ...init, headers }));
    };

    const response = await dispatchStartAutomation(createHttpApiClient(browserFetch), {
      revisionIds: ["revision-from-workbench"]
    });

    expect(response.runs[0]).toMatchObject({ revisionId: "revision-from-workbench", created: true });
    expect(repository.calls).toEqual([{ revisionId: "revision-from-workbench", processingVersion: 1 }]);
    expect(sentAuthorization).toBeNull();
  });

  it("starts the Web read/control plane in live mode without constructing external adapters", () => {
    const network = {
      query: () => { throw new Error("database must stay lazy during composition"); },
      connect: () => { throw new Error("database must stay lazy during composition"); }
    };

    const services = createServerServices({
      pool: network as never,
      config: {
        extensionToken: "extension-secret",
        externalAdapterMode: "live",
        assetRoot: "./data/assets",
        workerConcurrency: 2,
        maxCanvasRunsPerDay: 50,
        miaoshouConfigured: true,
        canvasConfigured: true,
        llmConfigured: true,
        exchangeRateConfigured: true
      }
    });

    expect(services.settings).toBeInstanceOf(SettingsService);
  });

  it("fails closed when the external adapter mode is misspelled", () => {
    expect(() => loadRuntimeConfig({
      DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
      TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_web_test",
      LOCAL_OPERATOR_ID: "operator-1",
      EXTENSION_TOKEN: "extension-secret",
      EXTERNAL_ADAPTER_MODE: "lvie",
      NODE_ENV: "production"
    })).toThrow(/EXTERNAL_ADAPTER_MODE/);
  });

  it("authenticates and queues only the two selected 1688 links", async () => {
    const uow = new MemoryIngestJobs();
    const handler = createIngestHandler({
      verifyToken: createExtensionTokenVerifier("extension-secret"),
      service: new IngestService(uow)
    });
    const body = {
      version: 1,
      batchId: "batch-1",
      items: [
        { sourceUrl: "https://detail.1688.com/offer/1.html", idempotencyKey: "key-1" },
        { sourceUrl: "https://detail.1688.com/offer/2.html", idempotencyKey: "key-2" }
      ]
    };

    const response = await handler(jsonRequest("http://127.0.0.1/api/v1/ingest-links", body));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.jobs).toEqual([
      { idempotencyKey: "key-1", jobId: "job-1" },
      { idempotencyKey: "key-2", jobId: "job-2" }
    ]);
    expect(uow.audits).toHaveLength(2);
    expect(JSON.stringify(uow.audits)).not.toContain("extension-secret");
  });

  it("rejects a bad token without echoing either token", async () => {
    const handler = createIngestHandler({
      verifyToken: createExtensionTokenVerifier("extension-secret"),
      service: new IngestService(new MemoryIngestJobs())
    });
    const response = await handler(jsonRequest("http://127.0.0.1/api/v1/ingest-links", {
      version: 1,
      batchId: "batch-1",
      items: [{ sourceUrl: "https://detail.1688.com/offer/1.html", idempotencyKey: "key-1" }]
    }, "wrong-secret"));
    const text = await response.text();

    expect(response.status).toBe(401);
    expect(text).not.toContain("wrong-secret");
    expect(text).not.toContain("extension-secret");
  });

  it("returns the same queued job for a repeated ingest idempotency key", async () => {
    const handler = createIngestHandler({
      verifyToken: createExtensionTokenVerifier("extension-secret"),
      service: new IngestService(new MemoryIngestJobs())
    });
    const body = {
      version: 1,
      batchId: "batch-1",
      items: [{ sourceUrl: "https://detail.1688.com/offer/1.html", idempotencyKey: "key-1" }]
    };

    const first = await (await handler(jsonRequest("http://127.0.0.1/api/v1/ingest-links", body))).json();
    const second = await (await handler(jsonRequest("http://127.0.0.1/api/v1/ingest-links", body))).json();

    expect(second.jobs[0].jobId).toBe(first.jobs[0].jobId);
  });

  it("starts each existing revision through the frozen automation repository", async () => {
    const uow = new MemoryAutomationRuns();
    const handler = createAutomationHandler({
      service: new AutomationService({ processingVersion: async () => 1 }, uow)
    });

    const response = await handler(jsonRequest("http://127.0.0.1/api/v1/automation-runs", {
      version: 1,
      revisionIds: ["rev-1", "rev-2"]
    }));
    const payload = await response.json();

    expect(response.status).toBe(202);
    expect(payload.runs).toEqual([
      { revisionId: "rev-1", runId: "run-1", created: true },
      { revisionId: "rev-2", runId: "run-2", created: true }
    ]);
    expect(uow.calls).toEqual([
      { revisionId: "rev-1", processingVersion: 1 },
      { revisionId: "rev-2", processingVersion: 1 }
    ]);
    expect(uow.audits).toHaveLength(2);
  });

  it("projects current revision and usable Canvas output counts in the product pool", async () => {
    const service = new ProductService({
      query: async () => ({
        rows: [{
          product_id: "product-1",
          current_revision_id: "revision-1",
          source_item_id: "1688-1",
          canonical_source_title: "Source title",
          target_title: "Target title",
          canonical_success_detail_id: "detail-1",
          locale: "th-TH",
          currency: "THB",
          price_minor: "29900",
          image_count: 8,
          canvas_outputs: ["https://images.test/one.png", "bad-value", null],
          state_source: "success",
          state_automation: "ready",
          state_asset_archive: "ready",
          state_listing: "ready",
          state_canvas: "partial",
          state_approval: "unapproved",
          state_miaoshou_edit: "not_started",
          warning_codes: ["canvas_partial"]
        }]
      })
    });
    const response = await createProductsHandler({ service })(
      new Request("http://127.0.0.1/api/v1/products")
    );
    const payload = await response.json();

    expect(payload.items[0]).toMatchObject({
      productId: "product-1",
      currentRevisionId: "revision-1",
      imageCount: 8,
      usableCanvasOutputCount: 1
    });
  });

  it("returns only secret status booleans from settings", async () => {
    let record: import("../../../server/services/settings-service").WorkspaceSettingsRecord | undefined;
    const defaults = {
      defaultLocale: "th-TH", defaultCurrency: "THB", externalAdapterMode: "mock" as const,
      workerConcurrency: 2, maxCanvasRunsPerDay: 50, assetRoot: "./data/assets",
      pricingDefaults: { domesticShippingCny: "2.00", crossBorderCostCny: "6.00", fixedTargetCostThb: "10.00", platformFeeRate: "0.05", paymentFeeRate: "0.03", targetProfitRate: "0.30", ending: "9" },
      providerOptions: { listingProvider: "rules", listingModel: "rules-v1", canvasWorkflow: "TK工作流" },
      retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 }
    };
    const service = new SettingsService({
      initialize: async (initial) => { record ??= initial; },
      get: async () => record,
      update: async () => undefined
    }, {
      defaults,
      secretStatus: {
        miaoshouConfigured: true,
        canvasConfigured: true,
        llmConfigured: false,
        exchangeRateConfigured: true
      }
    });
    const response = await createSettingsHandler({ service })(
      new Request("http://127.0.0.1/api/v1/settings")
    );
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(JSON.parse(text).secretStatus.miaoshouConfigured).toBe(true);
    expect(text).not.toMatch(/app[_-]?secret|api[_-]?key|extension-secret/i);

    const nonLoopback = await createSettingsHandler({ service })(
      new Request("http://192.168.1.8/api/v1/settings")
    );
    expect(nonLoopback.status).toBe(403);
  });

  it("serves product detail, task center, templates, and audited task actions", async () => {
    const productService = new ProductService({
      query: async () => ({ rows: [{
        product_id: "product-1",
        revision_id: "revision-1",
        draft_version: 1,
        source_title: "Source title",
        source_payload: { mainImages: ["https://images.test/source.png"] },
        working_draft: { finalAssetOrder: ["asset-1"], warningCodes: ["canvas_partial"] },
        target_locale: "th-TH",
        target_title: "Target title",
        target_description: "Target description",
        target_style: "concise",
        target_provider: "mock",
        target_model: "mock-v1",
        target_fallback_used: false,
        pricing_run_id: "pricing-1",
        price_currency: "THB",
        final_price_minor: "29900",
        pricing_breakdown: { base: "10000" },
        canvas_run_id: "canvas-1",
        canvas_outputs: ["https://images.test/generated.png"],
        canvas_state: "partial",
        template_id: "template-1",
        template_version: 1,
        template_reason: "default"
      }] })
    });
    const productResponse = await createProductHandler({ service: productService })(
      new Request("http://127.0.0.1/api/v1/products/product-1"),
      { params: Promise.resolve({ productId: "product-1" }) }
    );
    const product = await productResponse.json();
    expect(product.revisionId).toBe("revision-1");
    expect(product.target.title).toBe("Target title");
    expect(product.pricing.finalPriceWire).toEqual({ amountMinor: "29900", currency: "THB" });
    expect(product.canvas.outputs).toEqual(["https://images.test/generated.png"]);
    expect(product.finalAssetOrder).toEqual(["asset-1"]);

    const taskService = new TaskService({
      query: async () => ({ rows: [{
        id: "job-1", kind: "asset_archive", status: "failed", attempt: 1,
        max_attempts: 3, next_attempt_at: null, pause_reason: null, owner: null,
        error: { kind: "retryable", code: "network", safeMessage: "Temporary error" },
        revision_id: "revision-1"
      }] })
    }, {
      execute: async (command) => command({
        tasks: { act: async () => true },
        audit: { append: async () => "audit-1" }
      })
    });
    const taskResponse = await createTasksHandler({ service: taskService })(
      new Request("http://127.0.0.1/api/v1/tasks")
    );
    expect((await taskResponse.json()).items[0].jobId).toBe("job-1");
    const actionResponse = await createTaskActionHandler({ service: taskService })(
      jsonRequest("http://127.0.0.1/api/v1/tasks/job-1/actions", { action: "retry" }),
      { params: Promise.resolve({ taskId: "job-1" }) }
    );
    expect(actionResponse.status).toBe(202);

    const templates = new TemplateService({
      list: async () => [{
        recordId: "template-version-1", templateId: "template-1", name: "TK",
        categoryRules: [], referenceAssetIds: [], promptFragment: "", targetLocale: "th-TH",
        visualStyle: "clean", enabled: true, version: 1
      }],
      create: async (record) => record,
      appendVersion: async (_templateId, _expectedVersion, record) => record
    });
    const templateResponse = await createTemplatesHandler({ service: templates })(
      new Request("http://127.0.0.1/api/v1/templates")
    );
    expect((await templateResponse.json()).items[0].name).toBe("TK");
  });
});

const pgTestUrl = process.env.TEST_DATABASE_URL;

describe.runIf(Boolean(pgTestUrl))("v1 API PostgreSQL integration", () => {
  it("persists idempotent collection and automation jobs with redacted audits", async () => {
    const pool = new pg.Pool({ connectionString: pgTestUrl });
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await pool.query(INITIAL_SQL);
      await pool.query(
        `INSERT INTO local_operators (id, handle, display_name) VALUES ('operator-1', 'local', 'Local')`
      );
      await pool.query(
        `INSERT INTO products (id, operator_id, source_url, source_item_id, canonical_success_detail_id,
          state_source) VALUES
         ('product-1', 'operator-1', 'https://detail.1688.com/offer/1.html', 'source-1', 'detail-1', 'success'),
         ('product-2', 'operator-1', 'https://detail.1688.com/offer/2.html', 'source-2', 'detail-2', 'success')`
      );
      await pool.query(
        `INSERT INTO product_revisions
          (id, product_id, draft_version, source_title, source_payload, working_draft) VALUES
         ('revision-1', 'product-1', 1, 'One', '{"imageUrls":["https://images.test/1.png"]}', '{}'),
         ('revision-2', 'product-2', 1, 'Two', '{"imageUrls":["https://images.test/2.png"]}', '{}')`
      );
      const services = createServerServices({
        pool,
        config: {
          extensionToken: "extension-secret",
          externalAdapterMode: "mock",
          assetRoot: "./data/assets",
          workerConcurrency: 2,
          maxCanvasRunsPerDay: 50,
          miaoshouConfigured: false,
          canvasConfigured: false,
          llmConfigured: false,
          exchangeRateConfigured: false
        }
      });
      const ingest = createIngestHandler({
        verifyToken: services.verifyExtensionToken,
        service: services.ingest
      });
      const ingestBody = {
        version: 1,
        batchId: "batch-pg",
        items: [{
          sourceUrl: "https://detail.1688.com/offer/1.html",
          idempotencyKey: "pg-ingest-key"
        }]
      };
      const first = await (await ingest(jsonRequest(
        "http://127.0.0.1/api/v1/ingest-links", ingestBody
      ))).json();
      const repeated = await (await ingest(jsonRequest(
        "http://127.0.0.1/api/v1/ingest-links", ingestBody
      ))).json();
      expect(repeated.jobs[0].jobId).toBe(first.jobs[0].jobId);

      const automation = createAutomationHandler({ service: services.automation });
      const started = await automation(jsonRequest(
        "http://127.0.0.1/api/v1/automation-runs",
        { version: 1, revisionIds: ["revision-1", "revision-2"] }
      ));
      expect(started.status).toBe(202);
      expect((await started.json()).runs).toHaveLength(2);

      const jobs = await pool.query<{ kind: string }>("SELECT kind FROM jobs ORDER BY kind");
      expect(jobs.rows.map((row) => row.kind)).toEqual([
        "asset_archive", "asset_archive", "miaoshou_collect"
      ]);
      await pool.query(
        `INSERT INTO jobs
          (id, kind, business_key, idempotency_key, payload, status, attempt,
           max_attempts, owner, lease_token, lease_expires_at, remote_task_id, error)
         VALUES
          ('job-running-canvas', 'canvas_generate', 'running-canvas', 'running-canvas', '{}',
           'running', 1, 3, 'worker-1', 'lease-1', now() + interval '5 minutes', NULL, NULL),
          ('job-unknown-canvas', 'canvas_generate', 'unknown-canvas', 'unknown-canvas', '{}',
           'needs_input', 1, 3, NULL, NULL, NULL, NULL,
           '{"kind":"reconcile_required","code":"reconcile_required","safeMessage":"Result unknown; reconcile first"}'),
          ('job-external-failed', 'canvas_generate', 'external-failed', 'external-failed', '{}',
           'failed', 1, 3, NULL, NULL, NULL, 'remote-task-1',
           '{"kind":"retryable","code":"remote_failed","safeMessage":"Remote failed"}'),
          ('job-reconcile-failed', 'canvas_generate', 'reconcile-failed', 'reconcile-failed', '{}',
           'failed', 1, 3, NULL, NULL, NULL, NULL,
           '{"kind":"reconcile_required","code":"reconcile_required","safeMessage":"Reconcile first"}'),
          ('job-queued-pause', 'asset_archive', 'queued-pause', 'queued-pause', '{}',
           'queued', 0, 3, NULL, NULL, NULL, NULL, NULL)`
      );
      await expect(services.tasks.act("job-running-canvas", "pause")).resolves.toBe(false);
      await expect(services.tasks.act("job-unknown-canvas", "retry")).resolves.toBe(false);
      await expect(services.tasks.act("job-external-failed", "retry")).resolves.toBe(false);
      await expect(services.tasks.act("job-reconcile-failed", "retry")).resolves.toBe(false);
      await expect(services.tasks.act("job-queued-pause", "pause", "Check image quality")).resolves.toBe(true);
      const pausedTask = (await services.tasks.list()).items.find((item) => String(item.jobId) === "job-queued-pause");
      expect(pausedTask).toMatchObject({ status: "paused", pauseReason: "Check image quality" });
      const protectedJobs = await pool.query<{
        id: string; status: string; owner: string | null; lease_token: string | null;
      }>(
        `SELECT id, status, owner, lease_token FROM jobs
         WHERE id IN ('job-running-canvas', 'job-unknown-canvas') ORDER BY id`
      );
      expect(protectedJobs.rows).toEqual([
        { id: "job-running-canvas", status: "running", owner: "worker-1", lease_token: "lease-1" },
        { id: "job-unknown-canvas", status: "needs_input", owner: null, lease_token: null }
      ]);

      const audits = await pool.query<{ payload: Record<string, unknown>; redacted: boolean }>(
        "SELECT payload, redacted FROM audit_events ORDER BY created_at"
      );
      expect(audits.rows).toHaveLength(5);
      expect(audits.rows.every((row) => row.redacted)).toBe(true);
      expect(JSON.stringify(audits.rows)).not.toContain("extension-secret");
    } finally {
      await pool.end();
    }
  }, 60_000);

  it("persists versioned settings and immutable template history across service restarts", async () => {
    const pool = new pg.Pool({ connectionString: pgTestUrl });
    const config = {
      extensionToken: "extension-secret", externalAdapterMode: "mock" as const,
      assetRoot: "./data/assets", workerConcurrency: 2, maxCanvasRunsPerDay: 50,
      miaoshouConfigured: false, canvasConfigured: false, llmConfigured: false,
      exchangeRateConfigured: false
    };
    try {
      await pool.query("DROP SCHEMA IF EXISTS public CASCADE");
      await pool.query("CREATE SCHEMA public");
      await pool.query(INITIAL_SQL);
      const first = createServerServices({ pool, config });
      expect((await first.settings.get()).version).toBe(1);
      const saved = await createSettingsPatchHandler({ service: first.settings })(mutationRequest(
        "http://127.0.0.1/api/v1/settings",
        { expectedVersion: 1, defaultLocale: "vi-VN", workerConcurrency: 4 }
      ));
      expect(saved.status).toBe(200);

      const restarted = createServerServices({ pool, config: { ...config, canvasConfigured: true } });
      expect(await restarted.settings.get()).toMatchObject({
        version: 2, defaultLocale: "vi-VN", workerConcurrency: 4,
        secretStatus: { canvasConfigured: true }
      });
      const stale = await createSettingsPatchHandler({ service: restarted.settings })(mutationRequest(
        "http://127.0.0.1/api/v1/settings", { expectedVersion: 1, defaultLocale: "id-ID" }
      ));
      expect(stale.status).toBe(409);

      const createdResponse = await createTemplatePostHandler({ service: first.templates })(mutationRequest(
        "http://127.0.0.1/api/v1/templates",
        { name: "TK", categoryRules: [{ categoryKey: "dress", priority: 10 }],
          referenceAssetIds: [], promptFragment: "v1 prompt", targetLocale: "th-TH",
          visualStyle: "marketplace", enabled: true }
      ));
      const created = await createdResponse.json();
      expect(createdResponse.status).toBe(201);
      const updatedResponse = await createTemplatePatchHandler({ service: restarted.templates })(mutationRequest(
        "http://127.0.0.1/api/v1/templates",
        { templateId: created.templateId, expectedVersion: 1, promptFragment: "v2 prompt" }
      ));
      expect(updatedResponse.status).toBe(200);
      const templateStale = await createTemplatePatchHandler({ service: restarted.templates })(mutationRequest(
        "http://127.0.0.1/api/v1/templates",
        { templateId: created.templateId, expectedVersion: 1, promptFragment: "stale" }
      ));
      expect(templateStale.status).toBe(409);
      const history = await pool.query<{ version: number; prompt_fragment: string }>(
        "SELECT version, prompt_fragment FROM templates WHERE template_key = $1 ORDER BY version",
        [created.templateId]
      );
      expect(history.rows).toEqual([
        { version: 1, prompt_fragment: "v1 prompt" },
        { version: 2, prompt_fragment: "v2 prompt" }
      ]);
    } finally {
      await pool.end();
    }
  }, 60_000);
});

function mutationRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "PATCH",
    headers: { origin: new URL(url).origin, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
