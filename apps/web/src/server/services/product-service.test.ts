import { describe, expect, it, vi } from "vitest";
import type {
  ApprovalPreviewV1,
  ProductFactsData,
  ProductPoolItemV1,
  ProductWorkspaceV1
} from "@tk/contracts";

import { ProductService, type ProductCatalogPort } from "./product-service";

function createMockCatalog(overrides: Partial<ProductCatalogPort> = {}): ProductCatalogPort {
  return {
    listProductPool: vi.fn().mockResolvedValue([]),
    getProductWorkspace: vi.fn().mockResolvedValue(null),
    getApprovalPreview: vi.fn().mockResolvedValue(null),
    getProductFacts: vi.fn().mockResolvedValue({
      skuCount: null,
      orderedFinalImages: [],
      stock: null,
      weightKg: null,
      dimensions: null,
      canonicalMiaoshouTarget: null
    }),
    getAssetLocalPath: vi.fn().mockResolvedValue(null),
    ...overrides
  };
}

describe("ProductService delegation to ProductCatalogPort", () => {
  it("delegates list() to catalog.listProductPool() and wraps items", async () => {
    const fakePoolItem: ProductPoolItemV1 = {
      productId: "prod-1" as any,
      currentRevisionId: "rev-1" as any,
      sourceItemId: "item-1" as any,
      sourceUrl: "https://detail.1688.com/offer/1.html",
      thumbnailUrl: "/api/v1/assets/asset-1/content",
      originalImageUrls: ["/api/v1/assets/asset-1/content"],
      processedImageUrls: ["/api/v1/assets/canvas-1/content"],
      collectedAt: "2026-07-24T08:00:00.000Z",
      updatedAt: "2026-07-24T08:01:00.000Z",
      canonicalSourceTitle: "测试商品",
      targetTitle: "Target Title",
      canonicalSuccessDetailId: null,
      locale: "th-TH",
      currency: "THB",
      priceWire: null,
      sourcePriceWire: null,
      sourceImageCount: 2,
      sourceCaptureQuality: null,
      imageCount: 2,
      usableCanvasOutputCount: 1,
      miaoshouSource: "success",
      automation: "ready",
      assetArchive: "ready",
      listing: "ready",
      canvas: "not_started",
      approval: "unapproved",
      miaoshouEdit: "not_started",
      warningCodes: []
    };

    const catalog = createMockCatalog({
      listProductPool: vi.fn().mockResolvedValue([fakePoolItem])
    });
    const service = new ProductService(catalog);

    const result = await service.list();

    expect(catalog.listProductPool).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ items: [fakePoolItem] });
  });

  it("delegates get() to catalog.getProductWorkspace() with exact productId", async () => {
    const fakeWorkspace: ProductWorkspaceV1 = {
      productId: "prod-1" as any,
      revisionId: "rev-1" as any,
      draftVersion: 1,
      originalListing: null,
      target: null,
      pricing: null,
      template: null,
      canvas: null,
      imageGeneration: null,
      finalAssetOrder: [],
      warningCodes: []
    };

    const catalog = createMockCatalog({
      getProductWorkspace: vi.fn().mockResolvedValue(fakeWorkspace)
    });
    const service = new ProductService(catalog);

    const result = await service.get("prod-1");

    expect(catalog.getProductWorkspace).toHaveBeenCalledWith("prod-1");
    expect(result).toBe(fakeWorkspace);
  });

  it("returns null from get() when workspace is not found", async () => {
    const catalog = createMockCatalog({
      getProductWorkspace: vi.fn().mockResolvedValue(null)
    });
    const service = new ProductService(catalog);

    const result = await service.get("prod-nonexistent");

    expect(catalog.getProductWorkspace).toHaveBeenCalledWith("prod-nonexistent");
    expect(result).toBeNull();
  });

  it("delegates preview() to catalog.getApprovalPreview() with exact productId", async () => {
    const fakePreview: ApprovalPreviewV1 = {
      productId: "prod-1" as any,
      draftVersion: 1,
      listingRunId: "listing-1",
      pricingRunId: "pricing-1",
      templateVersion: 3,
      orderedFinalAssetIds: [],
      locale: "th-TH",
      currency: "THB",
      finalPriceWire: null,
      warningCodes: [],
      miaoshouTargetDetailId: null,
      miaoshouWriteback: {
        state: "not_started",
        failureCode: null,
        safeMessage: null,
        retryAllowed: false,
        approvalSnapshotId: null
      }
    };

    const catalog = createMockCatalog({
      getApprovalPreview: vi.fn().mockResolvedValue(fakePreview)
    });
    const service = new ProductService(catalog);

    const result = await service.preview("prod-1");

    expect(catalog.getApprovalPreview).toHaveBeenCalledWith("prod-1");
    expect(result).toBe(fakePreview);
  });

  it("returns null from preview() when preview data is not available", async () => {
    const catalog = createMockCatalog({
      getApprovalPreview: vi.fn().mockResolvedValue(null)
    });
    const service = new ProductService(catalog);

    const result = await service.preview("prod-1");

    expect(catalog.getApprovalPreview).toHaveBeenCalledWith("prod-1");
    expect(result).toBeNull();
  });

  it("delegates facts() to catalog.getProductFacts() with exact productId", async () => {
    const fakeFacts: ProductFactsData = {
      skuCount: 3,
      orderedFinalImages: [
        {
          assetId: "asset-1",
          previewUrl: "/api/v1/assets/asset-1/content",
          thumbnailUrl: "/api/v1/assets/asset-1/content?variant=thumbnail"
        }
      ],
      stock: "100",
      weightKg: "0.5",
      dimensions: { lengthCm: "10", widthCm: "20", heightCm: "30" },
      canonicalMiaoshouTarget: "detail-1"
    };

    const catalog = createMockCatalog({
      getProductFacts: vi.fn().mockResolvedValue(fakeFacts)
    });
    const service = new ProductService(catalog);

    const result = await service.facts("prod-1");

    expect(catalog.getProductFacts).toHaveBeenCalledWith("prod-1");
    expect(result).toBe(fakeFacts);
  });

  it("delegates assetLocalPath() to catalog.getAssetLocalPath() with exact assetId", async () => {
    const catalog = createMockCatalog({
      getAssetLocalPath: vi.fn().mockResolvedValue("/data/assets/asset-1.png")
    });
    const service = new ProductService(catalog);

    const result = await service.assetLocalPath("asset-1");

    expect(catalog.getAssetLocalPath).toHaveBeenCalledWith("asset-1");
    expect(result).toBe("/data/assets/asset-1.png");
  });

  it("returns null from assetLocalPath() when asset does not exist", async () => {
    const catalog = createMockCatalog({
      getAssetLocalPath: vi.fn().mockResolvedValue(null)
    });
    const service = new ProductService(catalog);

    const result = await service.assetLocalPath("nonexistent");

    expect(catalog.getAssetLocalPath).toHaveBeenCalledWith("nonexistent");
    expect(result).toBeNull();
  });

  it("adapts legacy QueryPort by creating a CatalogRepository instance", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [{
        product_id: "prod-legacy",
        current_revision_id: "rev-1",
        source_url: "https://detail.1688.com/offer/legacy.html",
        collected_at: new Date("2026-07-24T08:00:00.000Z"),
        updated_at: new Date("2026-07-24T08:01:00.000Z"),
        source_item_id: "legacy-1",
        canonical_source_title: "Legacy Product",
        target_title: null,
        canonical_success_detail_id: null,
        locale: "th-TH",
        currency: "THB",
        price_minor: null,
        source_price_minor: null,
        source_main_images: [],
        source_detail_images: [],
        archived_source_images: [],
        thumbnail_url: null,
        source_image_count: 0,
        source_capture_quality: null,
        image_count: 0,
        canvas_outputs: [],
        state_source: "success",
        state_automation: "ready",
        state_asset_archive: "ready",
        state_listing: "ready",
        state_canvas: "not_started",
        latest_canvas_job_status: null,
        latest_canvas_job_error: null,
        latest_automation_run_state: null,
        latest_blocking_job_kind: null,
        latest_blocking_job_status: null,
        latest_blocking_job_error: null,
        state_approval: "unapproved",
        state_miaoshou_edit: "not_started",
        warning_codes: []
      }]
    });

    const service = new ProductService({ query });
    const result = await service.list();

    expect(query).toHaveBeenCalled();
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.productId).toBe("prod-legacy");
  });
});
