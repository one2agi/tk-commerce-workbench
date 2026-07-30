import { describe, expect, it, vi } from "vitest";

import { ProductService } from "./product-service";

function poolRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: "prod-1",
    current_revision_id: "rev-1",
    source_url: "https://detail.1688.com/offer/1.html",
    collected_at: new Date("2026-07-24T08:00:00.000Z"),
    updated_at: new Date("2026-07-24T08:01:00.000Z"),
    source_item_id: "1",
    canonical_source_title: "测试商品",
    target_title: null,
    canonical_success_detail_id: "detail-1",
    locale: "th-TH",
    currency: "THB",
    price_minor: null,
    thumbnail_url: "https://img.test/1.jpg",
    source_image_count: 5,
    source_capture_quality: null,
    image_count: 0,
    canvas_outputs: [],
    state_source: "success",
    state_automation: "not_started",
    state_asset_archive: "pending",
    state_listing: "pending",
    state_canvas: "not_started",
    latest_canvas_job_status: null,
    latest_canvas_job_error: null,
    latest_automation_run_state: null,
    latest_blocking_job_kind: null,
    latest_blocking_job_status: null,
    latest_blocking_job_error: null,
    state_approval: "unapproved",
    state_miaoshou_edit: "not_started",
    warning_codes: [],
    ...overrides
  };
}

describe("ProductService.list runtime projection", () => {
  it("restores processing state from a queued automation run after browser refresh", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [poolRow({ latest_automation_run_state: "queued" })]
    });

    const result = await new ProductService({ query }).list();

    expect(result.items[0]).toMatchObject({
      productId: "prod-1",
      automation: "queued",
      canvas: "not_started"
    });
  });

  it("projects a historical pricing needs-input job as resumable without blocking listing readiness", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [poolRow({
        state_asset_archive: "ready",
        state_listing: "ready",
        latest_automation_run_state: "queued",
        latest_blocking_job_kind: "pricing_calculate",
        latest_blocking_job_status: "needs_input",
        latest_blocking_job_error: { code: "missing_weight" }
      })]
    });

    const result = await new ProductService({ query }).list();

    expect(result.items[0]).toMatchObject({
      automation: "needs_input",
      assetArchive: "ready",
      listing: "ready",
      canvas: "not_started",
      warningCodes: ["missing_weight"]
    });
  });

  it("selects a local archived source image before falling back to the remote 1688 URL", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [poolRow({
        thumbnail_url: "/api/v1/assets/asset-main/content",
        image_count: 5,
        state_asset_archive: "ready"
      })]
    });

    const result = await new ProductService({ query }).list();

    expect(result.items[0]?.thumbnailUrl).toBe("/api/v1/assets/asset-main/content");
    expect(query.mock.calls[0]?.[0]).toContain("archived_thumbnail.preview_url");
    expect(query.mock.calls[0]?.[0]).toContain("candidate.kind = 'main'");
  });
});
