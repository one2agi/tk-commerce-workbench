import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { assetId, productId, productRevisionId, templateId } from "@tk/contracts/ids";
import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

import { FinalReview } from "../components/review/final-review";
import { renderSettingsPage } from "./settings/page";
import { renderTasksPage } from "./tasks/page";
import { renderTemplatesPage } from "./templates/page";
import { createPatchHandler as createDraftPatchHandler } from "./api/v1/products/[productId]/draft/route";
import { createPostHandler as createRerunPostHandler } from "./api/v1/products/[productId]/rerun/route";
import { createPostHandler as createConfirmPostHandler } from "./api/v1/products/[productId]/confirm-miaoshou-edit/route";
import { Sidebar } from "../components/navigation/sidebar";
import { ProductService } from "../server/services/product-service";

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

describe("final review flow", () => {
  it("shows Chinese source beside Thai draft, pricing, SKU count, warnings, selected assets and five outputs", () => {
    const html = renderToStaticMarkup(<FinalReview workspace={workspace} />);
    expect(html).toContain("aria-label=\"中文原始 Listing\"");
    expect(html).toContain("便携式榨汁杯");
    expect(html).toContain("aria-label=\"泰文目标 Listing\"");
    expect(html).toContain("เครื่องปั่นน้ำผลไม้แบบพกพา");
    expect(html).toContain("459.00 THB");
    expect(html).toContain("SKU 2 个");
    expect(html).toContain("W_TITLE_LONG");
    expect(html).toContain("asset-2");
    expect(html.match(/alt=\"Canvas 产出/g)).toHaveLength(5);
    expect(html).toContain("确认并推送妙手");
    expect(html).not.toContain("发布 TikTok");
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
    const templatesHtml = renderToStaticMarkup(renderTemplatesPage({ items: [{
      templateId: templateId("template-13"),
      name: "TK 榨汁杯",
      categoryRules: [{ categoryKey: "kitchen", priority: 10 }],
      referenceAssetIds: [assetId("reference-1")],
      promptFragment: "clean background",
      targetLocale: "th-TH",
      visualStyle: "marketplace",
      enabled: true,
      version: 3
    }] }));
    expect(templatesHtml).toContain("TK 榨汁杯");
    expect(templatesHtml).toContain("v3");
    expect(templatesHtml).toContain("clean background");

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
      assetRoot: "./data/assets"
    }));
    expect(settingsHtml).toContain("MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET");
    expect(settingsHtml).toContain("已配置");
    expect(settingsHtml).toContain("未配置");
    expect(settingsHtml).not.toContain("type=\"password\"");
  });
});

describe("version-aware review routes", () => {
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

  it("patches only locale/style overrides and reports approval invalidation", async () => {
    const update = vi.fn().mockResolvedValue({ draftVersion: 5, approvalInvalidated: true });
    const response = await createDraftPatchHandler({ drafts: { update } })(
      sameOriginRequest("http://127.0.0.1/api/v1/products/product-13/draft", "PATCH", {
        version: 1,
        targetLocale: "en-US",
        translationStyle: "concise"
      }),
      { params: Promise.resolve({ productId: "product-13" }) }
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      version: 1,
      productId: "product-13",
      targetLocale: "en-US",
      translationStyle: "concise"
    });
    expect(await response.json()).toMatchObject({ approvalInvalidated: true, draftVersion: 5 });
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
});

function sameOriginRequest(url: string, method: string, body: unknown): Request {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", origin: new URL(url).origin },
    body: JSON.stringify(body)
  });
}
