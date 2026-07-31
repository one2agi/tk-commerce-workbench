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
    source_main_images: [
      { url: "https://cbu01.alicdn.com/main-1.jpg" },
      "https://cbu01.alicdn.com/main-2.jpg"
    ],
    source_detail_images: [
      { url: "https://cbu01.alicdn.com/main-1.jpg" },
      { url: "https://img.alicdn.com/detail-1.jpg" },
      { url: "https://example.com/rejected.jpg" }
    ],
    archived_source_images: [{
      remoteUrl: "https://cbu01.alicdn.com/main-1.jpg",
      localUrl: "/api/v1/assets/asset-main-1/content"
    }],
    source_image_count: 5,
    source_capture_quality: null,
    image_count: 0,
    canvas_outputs: [
      "asset_canvas_1",
      "https://canvas.example/output-2.png",
      "invalid-output"
    ],
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
  it("projects ordered original images separately from processed images", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [poolRow()] });

    const result = await new ProductService({ query }).list();

    expect(result.items[0]).toMatchObject({
      thumbnailUrl: "/api/v1/assets/asset-main-1/content",
      originalImageUrls: [
        "/api/v1/assets/asset-main-1/content",
        "/api/v1/source-images?url=https%3A%2F%2Fcbu01.alicdn.com%2Fmain-2.jpg",
        "/api/v1/source-images?url=https%3A%2F%2Fimg.alicdn.com%2Fdetail-1.jpg"
      ],
      processedImageUrls: [
        "/api/v1/assets/asset_canvas_1/content",
        "https://canvas.example/output-2.png"
      ]
    });

    const sql = query.mock.calls[0]?.[0] as string;
    expect(sql).toContain("archived_source_images");
    expect(sql).toContain("source_main_images");
    expect(sql).toContain("source_detail_images");
  });

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
        archived_source_images: [{
          remoteUrl: "https://cbu01.alicdn.com/main-1.jpg",
          localUrl: "/api/v1/assets/asset-main/content"
        }],
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

describe("ProductService.facts detail image projection", () => {
  it("uses local archived assets for detail previews and thumbnails even when a remote URL exists", async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({
        rows: [{
          source_payload: {},
          final_asset_order: ["asset-2", "asset-1"],
          canonical_success_detail_id: "detail-1"
        }]
      })
      .mockResolvedValueOnce({
        rows: [
          { id: "asset-1", remote_url: "https://canvas.test/one.png", local_path: "/assets/one.png" },
          { id: "asset-2", remote_url: "https://canvas.test/two.png", local_path: "/assets/two.png" }
        ]
      });

    const result = await new ProductService({ query }).facts("prod-1");

    expect(result.orderedFinalImages).toEqual([
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
    ]);
  });
});

function previewRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: "prod-1",
    locale: "th-TH",
    currency: "THB",
    canonical_success_detail_id: "detail-1",
    draft_version: 1,
    revision_id: "rev-1",
    listing_run_id: "listing-1",
    pricing_run_id: null,
    final_price_minor: null,
    template_version: 3,
    final_asset_order: ["asset-1"],
    warning_codes: [],
    product_miaoshou_edit_state: "result_unknown",
    approval_snapshot_id: "approval-1",
    approval_revision_id: "rev-1",
    approval_draft_version: 1,
    sync_state: "result_unknown",
    sync_error: {
      kind: "reconcile_required",
      code: "miaoshou_reconcile_no_change",
      safeMessage: "remote unchanged"
    },
    edit_job_status: "needs_input",
    edit_job_error: { code: "reconcile_failed" },
    edit_job_remote_task_id: "canonical:detail-1:ctx:test",
    ...overrides
  };
}

describe("ProductService.preview Miaoshou writeback projection", () => {
  it("allows manual retry only for an explicitly reconciled no-change write", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [previewRow()] });

    const result = await new ProductService({ query }).preview("prod-1");

    expect(result?.miaoshouWriteback).toEqual({
      state: "result_unknown",
      failureCode: "miaoshou_reconcile_no_change",
      safeMessage: "remote unchanged",
      retryAllowed: true,
      approvalSnapshotId: "approval-1"
    });
    expect(query.mock.calls[0]?.[0]).toContain("miaoshou_syncs");
    expect(query.mock.calls[0]?.[0]).toContain("miaoshou_edit");
  });

  it("keeps generic result_unknown visible but does not allow retry", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [previewRow({
        sync_error: { kind: "reconcile_required", code: "miaoshou.network", safeMessage: "result unknown" },
        edit_job_error: { code: "reconcile_required" }
      })]
    });

    const result = await new ProductService({ query }).preview("prod-1");

    expect(result?.miaoshouWriteback).toMatchObject({
      state: "result_unknown",
      failureCode: "miaoshou.network",
      safeMessage: "result unknown",
      retryAllowed: false
    });
  });
});
