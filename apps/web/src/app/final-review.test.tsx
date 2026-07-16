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
import { renderTemplatesPage } from "./templates/page";
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
  it("shows Chinese source beside Thai draft, pricing, SKU count, warnings, selected assets and five outputs", () => {
    const html = renderToStaticMarkup(<FinalReview workspace={reviewWorkspace} />);
    expect(html).toContain("aria-label=\"中文原始 Listing\"");
    expect(html).toContain("便携式榨汁杯");
    expect(html).toContain("aria-label=\"1688 原图证据\"");
    expect(html).toContain("https://source.test/main.jpg");
    expect(html).toContain("aria-label=\"th-TH 目标 Listing\"");
    expect(html).toContain("เครื่องปั่นน้ำผลไม้แบบพกพา");
    expect(html).toContain("459.00 THB");
    expect(html).toContain("SKU 2 个");
    expect(html).toContain("库存 28");
    expect(html).toContain("重量 0.65 kg");
    expect(html).toContain("20 × 10 × 8 cm");
    expect(html).toContain("妙手目标 detail-13");
    expect(html).toContain("W_TITLE_LONG");
    expect(html).toContain("asset-2");
    expect(html).toContain("https://images.test/final-2.jpg");
    expect(html.match(/alt=\"Canvas 产出/g)).toHaveLength(5);
    expect(html).toContain("确认并推送妙手");
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

  it("uses a custom approval preview locale when the target listing is not available yet", () => {
    const html = renderToStaticMarkup(<FinalReview
      workspace={{ ...reviewWorkspace, target: null }}
      approvalPreview={{
        productId: productId("product-13"), draftVersion: 4,
        listingRunId: "listing-13", pricingRunId: "pricing-13", templateVersion: 3,
        orderedFinalAssetIds: [assetId("asset-2")], locale: "ms-MY", currency: "THB",
        finalPriceWire: null, warningCodes: [], miaoshouTargetDetailId: null
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
  it("makes all Wave 3 work areas reachable from primary navigation", () => {
    const html = renderToStaticMarkup(<Sidebar />);
    expect(html).toContain("href=\"/tasks\"");
    expect(html).toContain("href=\"/templates\"");
    expect(html).toContain("href=\"/settings\"");
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

  it("shows template versioned controls and safe secret status only", () => {
    const currentTemplate = {
      templateId: templateId("template-13"),
      name: "TK 榨汁杯",
      categoryRules: [{ categoryKey: "kitchen", priority: 10 }],
      referenceAssetIds: [assetId("reference-1")],
      promptFragment: "clean background",
      targetLocale: "th-TH",
      visualStyle: "marketplace",
      enabled: true,
      version: 3
    };
    const templatesHtml = renderToStaticMarkup(renderTemplatesPage({ items: [
      currentTemplate,
      { ...currentTemplate, promptFragment: "old prompt", version: 2 }
    ] }));
    expect(templatesHtml).toContain("TK 榨汁杯");
    expect(templatesHtml).toContain("v3");
    expect(templatesHtml).toContain("clean background");
    expect(templatesHtml).toContain("基于 v3 创建新版本");
    expect(templatesHtml).toContain("v2 历史版本（只读）");
    expect(templatesHtml).not.toContain("基于 v2 创建新版本");
    expect(templatesHtml).not.toContain("disabled");

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
    expect(settingsHtml).toContain("MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET");
    expect(settingsHtml).toContain("已配置");
    expect(settingsHtml).toContain("未配置");
    expect(settingsHtml).not.toContain("type=\"password\"");
    expect(settingsHtml).toContain("定价公式默认值");
    expect(settingsHtml).toContain("name=\"platformFeeRate\"");
    expect(settingsHtml).toContain("name=\"paymentFeeRate\"");
    expect(settingsHtml).toContain("name=\"targetProfitRate\"");
    expect(settingsHtml).toContain("name=\"ending\"");
    expect(settingsHtml).toContain("保存非敏感设置");
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
        { assetId: "asset-2", previewUrl: "https://images.test/final-2.jpg" },
        { assetId: "asset-1", previewUrl: "/api/v1/assets/asset-1/content" }
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
      expectedPricingRunId: "pricing-13",
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
