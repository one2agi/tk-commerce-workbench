import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { assetId, productId, productRevisionId, templateId } from "@tk/contracts/ids";
import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

import { FinalReview } from "../components/review/final-review";
import { buildDraftUpdateCommand } from "../components/review/approval-actions";
import { renderSettingsPage } from "./settings/page";
import { renderTasksPage } from "./tasks/page";
import { renderProcessingRulesPage } from "./processing-rules/page";
import { createPatchHandler as createDraftPatchHandler } from "./api/v1/products/[productId]/draft/route";
import { createPostHandler as createRerunPostHandler } from "./api/v1/products/[productId]/rerun/route";
import { createPostHandler as createConfirmPostHandler } from "./api/v1/products/[productId]/confirm-miaoshou-edit/route";
import { Sidebar } from "../components/navigation/sidebar";
import { ProductService } from "../server/services/product-service";
import type { ReviewWorkspaceView } from "../components/review/review-workspace-view";
import { createGetHandler as createAssetContentHandler } from "./api/v1/assets/[assetId]/content/route";

const workspace: ProductWorkspaceV1 = {
  productId: productId("product-13"),
  revisionId: productRevisionId("revision-13"),
  draftVersion: 4,
  originalListing: {
    sourceTitle: "便携式榨汁杯",
    description: "六叶刀头，中文原始详情",
    sourceAttributes: [{ name: "容量", value: "450ml" }],
    saleAttributes: [
      { name: "颜色", value: "绿色" },
      { name: "颜色", value: "白色" }
    ],
    mainImages: ["https://source.test/main.jpg"],
    detailImages: ["https://source.test/detail.jpg"]
  },
  target: {
    locale: "th-TH",
    title: "เครื่องปั่นน้ำผลไม้แบบพกพา",
    description: "ใบมีดหกแฉก",
    style: "marketplace",
    provider: "llm",
    model: "mock",
    fallbackUsed: false
  },
  pricing: {
    pricingRunId: "pricing-13",
    currency: "THB",
    finalPriceWire: { amountMinor: "45900", currency: "THB" },
    breakdown: { source: "129 CNY", exchange: "× 4.85", margin: "+ 30%" },
    exchangeRate: null
  },
  template: {
    templateId: templateId("template-13"),
    version: 3,
    matchedReason: "榨汁杯类目"
  },
  canvas: {
    runId: "canvas-13",
    state: "succeeded",
    outputs: Array.from({ length: 5 }, (_, index) => `https://canvas.test/output-${index + 1}.jpg`)
  },
  imageGeneration: null,
  finalAssetOrder: [assetId("asset-2"), assetId("asset-1")],
  warningCodes: ["W_TITLE_LONG"]
};

const reviewWorkspace: ReviewWorkspaceView = {
  ...workspace,
  reviewFacts: {
    skuCount: 2,
    orderedFinalImages: [
      { assetId: "asset-2", previewUrl: "https://images.test/final-2.jpg" },
      { assetId: "asset-1", previewUrl: "https://images.test/final-1.jpg" }
    ],
    stock: "28",
    weightKg: "0.65",
    dimensions: { lengthCm: "20", widthCm: "10", heightCm: "8" },
    canonicalMiaoshouTarget: "detail-13"
  }
};

describe("final review flow", () => {
  it("shows Chinese source beside Thai draft, SKU count, warnings, selected assets and five outputs", () => {
    const html = renderToStaticMarkup(<FinalReview workspace={reviewWorkspace} />);
    expect(html).toContain("aria-label=\"中文原始 Listing\"");
    expect(html).toContain("便携式榨汁杯");
    expect(html).toContain("1688 原图 2 张");
    expect(html).toContain("href=\"https://source.test/main.jpg\"");
    expect(html).toContain("aria-label=\"th-TH 目标 Listing\"");
    expect(html).toContain("เครื่องปั่นน้ำผลไม้แบบพกพา");
    expect(html).not.toContain("自动定价");
    expect(html).toContain("SKU 2 个");
    expect(html).toContain("库存 28");
    expect(html).toContain("重量 0.65 kg");
    expect(html).toContain("20 × 10 × 8 cm");
    expect(html).toContain("妙手目标 detail-13");
    expect(html).toContain("W_TITLE_LONG");
    expect(html).toContain("最终图 1");
    expect(html).toContain("https://images.test/final-2.jpg");
    expect(html.match(/alt=\"待确认 Canvas 产出/g)).toHaveLength(5);
    expect(html).toContain("确认写回妙手");
    expect(html).not.toContain("发布 TikTok");
  });

  it("shows unknown instead of guessing SKU count from sale attributes", () => {
    const html = renderToStaticMarkup(<FinalReview workspace={{
      ...reviewWorkspace,
      reviewFacts: { ...reviewWorkspace.reviewFacts, skuCount: null }
    }} />);
    expect(html).toContain("SKU 数量未知");
    expect(html).not.toContain("SKU 2 个");
  });

  it("keeps the image confirmation page product-facing without raw asset ids or invalid asset-image URLs", () => {
    const html = renderToStaticMarkup(<FinalReview workspace={{
      ...reviewWorkspace,
      canvas: {
        runId: "canvas-13",
        state: "succeeded",
        outputs: ["asset-2", "asset-1"]
      }
    }} />);

    expect(html).toContain("最终图 1");
    expect(html).not.toContain("待确认成图");
    expect(html).not.toContain("<code>asset-");
    expect(html).not.toContain("src=\"asset-");
  });

  it("uses a custom approval preview locale when the target listing is not available yet", () => {
    const html = renderToStaticMarkup(<FinalReview
      workspace={{ ...reviewWorkspace, target: null }}
      approvalPreview={{
        productId: productId("product-13"), draftVersion: 4,
        listingRunId: "listing-13", pricingRunId: "pricing-13", templateVersion: 3,
        orderedFinalAssetIds: [assetId("asset-2")], locale: "ms-MY", currency: "THB",
        finalPriceWire: null, warningCodes: [], miaoshouTargetDetailId: null,
        miaoshouWriteback: {
          state: "not_started", failureCode: null, safeMessage: null,
          retryAllowed: false, approvalSnapshotId: null
        }
      }}
    />);
    expect(html).toContain("value=\"ms-MY\"");
    expect(html).toContain("list=\"recommended-locales\"");
  });

  it("submits a saved custom BCP-47 locale unchanged", () => {
    expect(buildDraftUpdateCommand({
      productId: "product-13",
      draftVersion: 4,
      targetLocale: "ms-MY",
      translationStyle: "marketplace"
    })).toMatchObject({ targetLocale: "ms-MY", expectedDraftVersion: 4 });
    expect(() => buildDraftUpdateCommand({
      productId: "product-13",
      draftVersion: 4,
      targetLocale: "not_a_locale",
      translationStyle: "marketplace"
    })).toThrow("invalid_target_locale");
  });
});

describe("operational pages", () => {
  it("shows only the approved primary navigation items", () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).toContain("href=\"/\"");
    expect(html).toContain("商品");
    expect(html).toContain("href=\"/processing-rules\"");
    expect(html).toContain("处理规则");
    expect(html).toContain("href=\"/write-records\"");
    expect(html).toContain("写入记录");
    expect(html).toContain("href=\"/settings\"");
    expect(html).toContain("设置");
    expect(html).not.toContain("任务中心");
    expect(html).not.toContain("模板库");
  });

  it("groups task context and exposes recovery information", () => {
    const html = renderToStaticMarkup(renderTasksPage({ items: [{
      jobId: "job-1" as never,
      kind: "canvas_generate",
      status: "paused",
      attempt: 2,
      maxAttempts: 5,
      nextAttemptAt: "2026-07-16T08:00:00.000Z",
      pauseReason: "等待人工确认",
      owner: null,
      error: null,
      revisionId: "revision-13" as never
    }] }));
    expect(html).toContain("Canvas");
    expect(html).toContain("2 / 5");
    expect(html).toContain("等待人工确认");
  });

  it("shows processing rules without reference-image or visual-style configuration", () => {
    const rulesHtml = renderToStaticMarkup(renderProcessingRulesPage());
    expect(rulesHtml).toContain("处理规则");
    expect(rulesHtml).toContain("标题规则");
    expect(rulesHtml).toContain("TK工作流");
    expect(rulesHtml).toContain("最多输入 9 张图");
    expect(rulesHtml).toContain("期望输出 5 张图");
    expect(rulesHtml).not.toContain("参考图");
    expect(rulesHtml).not.toContain("生图风格");
  });

  it("shows safe secret status only", () => {
    const settingsHtml = renderToStaticMarkup(renderSettingsPage({
      defaultLocale: "th-TH",
      defaultCurrency: "THB",
      externalAdapterMode: "mock",
      secretStatus: {
        miaoshouConfigured: true,
        canvasConfigured: false,
        llmConfigured: true,
        exchangeRateConfigured: true
      },
      workerConcurrency: 2,
      maxCanvasRunsPerDay: 50,
      assetRoot: "./data/assets",
      version: 2,
      pricingDefaults: {
        domesticShippingCny: "2.00", crossBorderCostCny: "6.00",
        fixedTargetCostThb: "10.00", platformFeeRate: "0.05",
        paymentFeeRate: "0.03", targetProfitRate: "0.30", ending: "9"
      },
      providerOptions: { listingProvider: "rules", listingModel: "rules-v1", canvasWorkflow: "TK工作流" },
      retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 },
      applicationNote: "保存为工作区默认值"
    }));
    // SettingsWorkspace renders only real settings plus diagnostics
    expect(settingsHtml).toContain("基础设置");
    expect(settingsHtml).not.toContain("定价公式");
    expect(settingsHtml).toContain("处理运行边界");
    expect(settingsHtml).toContain("重试策略");
    expect(settingsHtml).toContain("密钥配置状态");
    expect(settingsHtml).toContain("系统诊断");
    expect(settingsHtml).toContain("打开任务日志");
    expect(settingsHtml).toContain("Worker 实际运行依赖启动配置");
    expect(settingsHtml).not.toContain("生图风格");
    expect(settingsHtml).not.toContain("参考图");
    // InfoBanner is always rendered
    expect(settingsHtml).toContain("修改这些值只更新工作区默认值");
    // StatusPill shows env-var name in .tk-pill__env
    expect(settingsHtml).toContain("MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET");
    // Configured/unconfigured state via CSS class (BEM class, not text "已配置"/"未配置")
    expect(settingsHtml).toContain("tk-pill is-ok");
    expect(settingsHtml).toContain("tk-pill is-warn");
    // No password inputs (security boundary preserved)
    expect(settingsHtml).not.toContain("type=\"password\"");
    // No SaveBar at idle (rendered only when dirty)
    expect(settingsHtml).not.toContain("tk-save-bar");
    expect(settingsHtml).not.toContain("影响每个商品的售价建议");
  });
});

describe("version-aware review routes", () => {
  it("serves only DB-known local previews inside the configured asset root", async () => {
    const temporary = await mkdtemp(join(tmpdir(), "tk-assets-"));
    const root = join(temporary, "root");
    const outside = join(temporary, "outside");
    await Promise.all([mkdir(root), mkdir(outside)]);
    const safeImage = join(root, "final.jpg");
    const secretImage = join(outside, "secret.jpg");
    const escapedLink = join(root, "escaped.jpg");
    await Promise.all([writeFile(safeImage, new Uint8Array([1, 2, 3])), writeFile(secretImage, new Uint8Array([9]))]);
    await symlink(secretImage, escapedLink);
    try {
      const handler = createAssetContentHandler({
        assets: { localPath: vi.fn().mockResolvedValue(safeImage) }, assetRoot: root
      });
      const response = await handler(
        new Request("http://127.0.0.1/api/v1/assets/asset-2/content"),
        { params: Promise.resolve({ assetId: "asset-2" }) }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/jpeg");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");

      const escaped = await createAssetContentHandler({
        assets: { localPath: vi.fn().mockResolvedValue(escapedLink) }, assetRoot: root
      })(new Request("http://127.0.0.1/api/v1/assets/asset-3/content"), {
        params: Promise.resolve({ assetId: "asset-3" })
      });
      expect(escaped.status).toBe(404);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  });

  it("preserves URLs from the real Miaoshou image payload shape", async () => {
    const service = new ProductService({ query: vi.fn().mockResolvedValue({ rows: [{
      product_id: "product-13", revision_id: "revision-13", draft_version: 4,
      source_title: "真实妙手商品", source_payload: {
        description: "详情", sourceAttributes: [], saleAttributes: [],
        mainImages: [{ url: "https://source.test/main.jpg", width: 800, height: 800 }],
        detailImages: [{ url: "https://source.test/detail.jpg", width: 790, height: 1200 }]
      },
      working_draft: {}, target_title: null, pricing_run_id: null, template_id: null, canvas_run_id: null
    }] }) });
    const projected = await service.get("product-13");
    expect(projected?.originalListing?.mainImages).toEqual(["https://source.test/main.jpg"]);
    expect(projected?.originalListing?.detailImages).toEqual(["https://source.test/detail.jpg"]);
  });

  it("projects source URL, thumbnail and timestamps for the product workbench list", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{
      product_id: "product-13",
      current_revision_id: "revision-13",
      source_url: "https://detail.1688.com/offer/1013001591920.html",
      collected_at: new Date("2026-07-22T10:00:00.000Z"),
      updated_at: new Date("2026-07-22T10:10:00.000Z"),
      source_item_id: "1013001591920",
      canonical_source_title: "真实妙手商品",
      target_title: null,
      canonical_success_detail_id: "detail-13",
      locale: "th-TH",
      currency: "THB",
      price_minor: null,
      thumbnail_url: "https://source.test/main.jpg",
      source_image_count: 2,
      image_count: 0,
      canvas_outputs: [],
      state_source: "success",
      state_automation: "not_started",
      state_asset_archive: "pending",
      state_listing: "pending",
      state_canvas: "not_started",
      state_approval: "unapproved",
      state_miaoshou_edit: "not_started",
      warning_codes: []
    }] });
    const service = new ProductService({ query });

    await expect(service.list()).resolves.toMatchObject({
      items: [{
        productId: "product-13",
        sourceUrl: "https://detail.1688.com/offer/1013001591920.html",
        thumbnailUrl: "https://source.test/main.jpg",
        collectedAt: "2026-07-22T10:00:00.000Z",
        updatedAt: "2026-07-22T10:10:00.000Z"
      }]
    });
    expect(query.mock.calls[0]?.[0]).toContain("final_thumbnail.preview_url");
    expect(query.mock.calls[0]?.[0]).toContain("finalAssetOrder");
  });

  it("projects the exact listing, pricing, template and ordered-asset versions used for confirmation", async () => {
    const service = new ProductService({ query: vi.fn().mockResolvedValue({ rows: [{
      product_id: "product-13",
      draft_version: 4,
      listing_run_id: "listing-13",
      pricing_run_id: "pricing-13",
      template_version: 3,
      final_asset_order: ["asset-2", "asset-1"],
      locale: "th-TH",
      currency: "THB",
      final_price_minor: "45900",
      warning_codes: ["W_TITLE_LONG"],
      canonical_success_detail_id: "detail-13"
    }] }) });

    await expect(service.preview("product-13")).resolves.toMatchObject({
      productId: "product-13",
      draftVersion: 4,
      listingRunId: "listing-13",
      pricingRunId: "pricing-13",
      templateVersion: 3,
      orderedFinalAssetIds: ["asset-2", "asset-1"],
      miaoshouTargetDetailId: "detail-13"
    });
  });

  it("projects evidence-backed review facts and ordered preview URLs", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [{
        source_payload: {
          detailId: "detail-13", sourceItemId: "source-13", sourceUrl: "https://detail.1688.com/offer/13.html",
          title: "真实妙手商品", itemNumber: null, description: "详情", category: "家居",
          sourcePriceWire: { amountMinor: "12900", currency: "CNY" }, sourceStock: 28,
          weightKg: "0.65",
          dimensionsCm: { lengthCm: "20", widthCm: "10", heightCm: "8" },
          mainImages: [{ url: "https://source.test/main.jpg", width: 800, height: 800 }],
          detailImages: [], sourceAttributes: [], saleAttributes: [], colors: [], sizes: [],
          skus: [{ skuId: "one", attributes: {}, priceWire: { amountMinor: "12900", currency: "CNY" }, stock: 10, imageUrl: null },
            { skuId: "two", attributes: {}, priceWire: { amountMinor: "13900", currency: "CNY" }, stock: 18, imageUrl: null }]
        },
        final_asset_order: ["asset-2", "asset-1"],
        canonical_success_detail_id: "detail-13"
      }] })
      .mockResolvedValueOnce({ rows: [
        { id: "asset-1", remote_url: "file:///data/final-1.jpg", local_path: "/data/final-1.jpg" },
        { id: "asset-2", remote_url: "https://images.test/final-2.jpg", local_path: "/data/asset-2.jpg" }
      ] });
    const facts = await new ProductService({ query }).facts("product-13");
    expect(facts).toEqual({
      skuCount: 2,
      orderedFinalImages: [
        {
          assetId: "asset-2",
          previewUrl: "/api/v1/assets/asset-2/content",
          thumbnailUrl: "/api/v1/assets/asset-2/content?variant=thumbnail"
        },
        {
          assetId: "asset-1",
          previewUrl: "/api/v1/assets/asset-1/content",
          thumbnailUrl: "/api/v1/assets/asset-1/content?variant=thumbnail"
        }
      ],
      stock: "28",
      weightKg: "0.65",
      dimensions: { lengthCm: "20", widthCm: "10", heightCm: "8" },
      canonicalMiaoshouTarget: "detail-13"
    });
  });

  it("keeps stock unknown when sourceStock is missing and the SKU list is empty", async () => {
    const query = vi.fn().mockResolvedValueOnce({ rows: [{
      source_payload: { sourceStock: null, skus: [] },
      final_asset_order: [], canonical_success_detail_id: null
    }] });
    await expect(new ProductService({ query }).facts("product-13")).resolves.toMatchObject({
      skuCount: 0,
      stock: null
    });
  });

  it("patches only locale/style overrides and reports approval invalidation", async () => {
    const update = vi.fn().mockResolvedValue({ draftVersion: 5, approvalInvalidated: true });
    const response = await createDraftPatchHandler({ drafts: { update } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/draft", "PATCH", {
        version: 1,
        expectedDraftVersion: 4,
        targetLocale: "en-US",
        translationStyle: "concise"
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      version: 1,
      productId: "product-13",
      expectedDraftVersion: 4,
      targetLocale: "en-US",
      translationStyle: "concise"
    });
    expect(await response.json()).toMatchObject({ approvalInvalidated: true, draftVersion: 5 });
  });

  it("rejects a non-BCP-47 locale before invoking the draft service", async () => {
    const update = vi.fn();
    const response = await createDraftPatchHandler({ drafts: { update } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/draft", "PATCH", {
        version: 1, expectedDraftVersion: 4, targetLocale: "not_a_locale"
      }), { params: Promise.resolve({ productId: "product-13" }) }
    );
    expect(response.status).toBe(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns safe version conflict metadata for a stale draft editor", async () => {
    const update = vi.fn().mockRejectedValue({
      code: "draft_version_conflict", field: "draftVersion", expected: "3", actual: "4", internal: "secret"
    });
    const response = await createDraftPatchHandler({ drafts: { update } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/draft", "PATCH", {
        version: 1,
        expectedDraftVersion: 3,
        targetLocale: "en-US"
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "draft_version_conflict",
      conflict: { field: "draftVersion", expected: "3", actual: "4" }
    });
  });

  it("returns a metadata-free 409 when draft invalidation is fenced by an active sync", async () => {
    const update = vi.fn().mockRejectedValue({
      code: "approval_sync_in_progress",
      metadata: { approvalSnapshotId: "approval-secret", syncState: "syncing", jobStatus: "running" }
    });
    const response = await createDraftPatchHandler({ drafts: { update } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/draft", "PATCH", {
        version: 1, expectedDraftVersion: 4, targetLocale: "en-US"
      }), { params: Promise.resolve({ productId: "product-13" }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "approval_sync_in_progress" });
  });

  it("reruns from an explicit node with the expected draft version", async () => {
    const enqueue = vi.fn().mockResolvedValue({
      accepted: true,
      revisionId: "revision-14",
      draftVersion: 6,
      approvalInvalidated: true,
      invalidatedNodes: ["canvas", "approval"]
    });
    const response = await createRerunPostHandler({ reruns: { enqueue } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/rerun", "POST", {
        version: 1,
        revisionId: "revision-13",
        expectedDraftVersion: 5,
        startNode: "canvas"
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );

    expect(response.status).toBe(202);
    expect(enqueue).toHaveBeenCalledWith({
      version: 1,
      revisionId: "revision-13",
      expectedDraftVersion: 5,
      startNode: "canvas"
    }, "product-13");
    expect(await response.json()).toMatchObject({
      revisionId: "revision-14",
      draftVersion: 6,
      approvalInvalidated: true
    });
  });

  it("returns a metadata-free 409 when rerun invalidation is fenced by an active sync", async () => {
    const enqueue = vi.fn().mockRejectedValue({
      code: "approval_sync_in_progress",
      metadata: { approvalSnapshotId: "approval-secret", syncState: "result_unknown", jobStatus: "paused" }
    });
    const response = await createRerunPostHandler({ reruns: { enqueue } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/rerun", "POST", {
        version: 1, revisionId: "revision-13", expectedDraftVersion: 5, startNode: "canvas"
      }), { params: Promise.resolve({ productId: "product-13" }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "approval_sync_in_progress" });
  });

  it("builds the single frozen Miaoshou confirmation command from the URL product", async () => {
    const confirmAndEnqueue = vi.fn().mockResolvedValue({ approvalSnapshotId: "approval-13", syncId: "sync-13" });
    const response = await createConfirmPostHandler({ approvals: { confirmAndEnqueue } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/confirm-miaoshou-edit", "POST", {
        version: 1,
        expectedDraftVersion: 5,
        expectedListingRunId: "listing-13",
        expectedPricingRunId: "pricing-13",
        expectedTemplateVersion: 3,
        orderedFinalAssetIds: ["asset-2", "asset-1"]
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );

    expect(response.status).toBe(202);
    expect(confirmAndEnqueue).toHaveBeenCalledTimes(1);
    expect(confirmAndEnqueue).toHaveBeenCalledWith({
      version: 1,
      productId: "product-13",
      expectedDraftVersion: 5,
      expectedListingRunId: "listing-13",
      expectedTemplateVersion: 3,
      orderedFinalAssetIds: ["asset-2", "asset-1"]
    });
  });

  it("returns safe confirmation conflict metadata without leaking internals", async () => {
    const confirmAndEnqueue = vi.fn().mockRejectedValue({
      code: "approval_conflict",
      metadata: { field: "orderedFinalAssetIds", expected: ["asset-2"], actual: ["asset-3"] },
      sql: "private"
    });
    const response = await createConfirmPostHandler({ approvals: { confirmAndEnqueue } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/confirm-miaoshou-edit", "POST", {
        version: 1,
        expectedDraftVersion: 5,
        expectedListingRunId: "listing-13",
        expectedPricingRunId: "pricing-13",
        expectedTemplateVersion: 3,
        orderedFinalAssetIds: ["asset-2"]
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "approval_conflict",
      conflict: { field: "orderedFinalAssetIds", expected: ["asset-2"], actual: ["asset-3"] }
    });
  });

  it("does not expose approval ids or worker state when sync is already in progress", async () => {
    const confirmAndEnqueue = vi.fn().mockRejectedValue({
      code: "approval_sync_in_progress",
      metadata: { approvalSnapshotId: "approval-secret", syncState: "syncing", jobStatus: "running" },
      message: "internal details"
    });
    const response = await createConfirmPostHandler({ approvals: { confirmAndEnqueue } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/confirm-miaoshou-edit", "POST", {
        version: 1,
        expectedDraftVersion: 5,
        expectedListingRunId: "listing-13",
        expectedPricingRunId: "pricing-13",
        expectedTemplateVersion: 3,
        orderedFinalAssetIds: ["asset-2"]
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "approval_sync_in_progress" });
  });

  it("does not expose conflict metadata outside the safe field allowlist", async () => {
    const confirmAndEnqueue = vi.fn().mockRejectedValue({
      code: "approval_conflict",
      metadata: { field: "internalSql", expected: "secret-before", actual: "secret-after" }
    });
    const response = await createConfirmPostHandler({ approvals: { confirmAndEnqueue } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/confirm-miaoshou-edit", "POST", {
        version: 1,
        expectedDraftVersion: 5,
        expectedListingRunId: "listing-13",
        expectedPricingRunId: "pricing-13",
        expectedTemplateVersion: 3,
        orderedFinalAssetIds: ["asset-2"]
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "approval_conflict" });
  });
});

function sameOriginRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", origin: new URL(url).origin },
    body: JSON.stringify(body)
  });
}
