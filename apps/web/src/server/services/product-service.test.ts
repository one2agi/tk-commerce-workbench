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

function workspaceRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    product_id: "prod_1",
    revision_id: "rev-1",
    draft_version: 1,
    source_title: "测试商品",
    source_payload: {
      description: "商品描述",
      sourceAttributes: [],
      saleAttributes: [],
      mainImages: [{ url: "https://cbu01.alicdn.com/main-1.jpg" }],
      detailImages: [{ url: "https://img.alicdn.com/detail-1.jpg" }]
    },
    working_draft: {},
    target_locale: "th-TH",
    target_title: null,
    target_description: null,
    target_style: null,
    target_provider: null,
    target_model: null,
    target_fallback_used: null,
    pricing_run_id: null,
    price_currency: null,
    final_price_minor: null,
    pricing_breakdown: null,
    canvas_run_id: null,
    canvas_outputs: null,
    canvas_state: null,
    template_id: null,
    template_version: null,
    template_reason: null,
    // imageGeneration fields
    batch_id: null,
    batch_state: null,
    batch_category_key: null,
    batch_requested_output_count: null,
    batch_selected_asset_ids: null,
    latest_batch_id: null,
    latest_batch_state: null,
    latest_batch_category_key: null,
    latest_batch_requested_output_count: null,
    latest_batch_selected_asset_ids: null,
    latest_batch_confirmed_category: null,
    available_assets: null,
    slots_json: null,
    slots_error: null,
    ...overrides
  };
}

describe("ProductService.get imageGeneration projection", () => {
  it("projects all ready source inputs before the first image generation batch", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [workspaceRow({
        batch_id: null,
        available_assets: [
          { assetId: "asset-1", localUrl: "/api/v1/assets/asset-1/content", role: "main" },
          { assetId: "asset-2", localUrl: "/api/v1/assets/asset-2/content", role: "detail" },
          { assetId: "asset-3", localUrl: "/api/v1/assets/asset-3/content", role: null }
        ]
      })]
    });

    const result = await new ProductService({ query }).get("prod_1");

    expect(result?.imageGeneration).toMatchObject({
      batchId: null,
      state: "not_started",
      requestedCount: 4,
      successfulCount: 0,
      selectedInputs: [],
      slots: []
    });
    expect(result?.imageGeneration?.availableInputs.map((item) => item.assetId)).toEqual([
      "asset-1",
      "asset-2",
      "asset-3"
    ]);
  });

  it("keeps original and processed images separate and local", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [workspaceRow({
        batch_id: "batch-1",
        batch_state: "generating",
        batch_category_key: "apparel",
        batch_requested_output_count: 2,
        batch_selected_asset_ids: ["asset-1", "asset-2"],
        available_assets: [
          { assetId: "asset-1", localUrl: "/api/v1/assets/asset-1/content", role: "main" },
          { assetId: "asset-2", localUrl: "/api/v1/assets/asset-2/content", role: "detail" },
          { assetId: "asset-3", localUrl: "/api/v1/assets/asset-3/content", role: null },
          { assetId: "asset-4", localUrl: "/api/v1/assets/asset-4/content", role: null },
          { assetId: "asset-5", localUrl: "/api/v1/assets/asset-5/content", role: null },
          { assetId: "asset-6", localUrl: "/api/v1/assets/asset-6/content", role: null }
        ],
        slots_json: [
          { slotId: "slot-1", slotNumber: 1, role: "main", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/slot-asset-1/content", error: null },
          { slotId: "slot-2", slotNumber: 2, role: "detail", status: "waiting_for_plan", attempt: 0, localUrl: null, error: null }
        ],
        source_payload: {
          description: "商品描述",
          sourceAttributes: [],
          saleAttributes: [],
          mainImages: [{ url: "https://cbu01.alicdn.com/main-1.jpg" }]
        }
      })]
    });

    const result = await new ProductService({ query }).get("prod_1");

    const sql = String(query.mock.calls[0]?.[0]);
    expect(sql).toContain("a.kind <> 'generated'");
    expect(sql).toContain("'sourceUrl', a.remote_url");
    expect(sql).toContain("archived.state = 'ready'");
    expect(sql).toContain("archived.local_path IS NOT NULL");
    expect(result?.imageGeneration?.availableInputs).toHaveLength(6);
    expect(result?.imageGeneration?.selectedInputs[0]?.localUrl).toMatch(/^\/api\/v1\/assets\//);
    expect(result?.imageGeneration?.slots.find((slot) => slot.status === "succeeded")?.localUrl).toMatch(/^\/api\/v1\/assets\//);
    expect(result?.originalListing?.mainImages).not.toContain(result?.imageGeneration?.slots[0]?.localUrl);
  });

  it("preserves selected source order and never projects provider URLs as generated thumbnails", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [workspaceRow({
        batch_id: "batch-order",
        batch_state: "generating",
        batch_category_key: "apparel",
        batch_requested_output_count: 2,
        batch_selected_asset_ids: ["asset-2", "asset-1"],
        available_assets: [
          { assetId: "asset-1", localUrl: "/api/v1/assets/asset-1/content", role: "main" },
          { assetId: "asset-2", localUrl: "/api/v1/assets/asset-2/content", role: "detail" }
        ],
        slots_json: [
          { slotId: "slot-1", slotNumber: 1, role: "main", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/generated-1/content", remoteOutputUrl: "https://provider.test/generated-1.png", error: null }
        ]
      })]
    });

    const result = await new ProductService({ query }).get("prod_1");

    expect(result?.imageGeneration?.selectedInputs.map((item) => item.assetId)).toEqual(["asset-2", "asset-1"]);
    expect(result?.imageGeneration?.slots[0]?.localUrl).toBe("/api/v1/assets/generated-1/content");
    expect(result?.imageGeneration?.slots[0]?.localUrl).not.toContain("provider.test");
  });

  it("projects the persisted accepted image order onto successful slots", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [workspaceRow({
        batch_id: "batch-accepted",
        batch_state: "partial_success",
        batch_category_key: "apparel",
        batch_requested_output_count: 3,
        batch_selected_asset_ids: ["asset-1"],
        batch_accepted_asset_ids: ["generated-2", "generated-1"],
        available_assets: [
          { assetId: "asset-1", localUrl: "/api/v1/assets/asset-1/content", role: "main" }
        ],
        slots_json: [
          { slotId: "slot-1", slotNumber: 1, role: "main", status: "succeeded", attempt: 1, archivedAssetId: "generated-1", localUrl: "/api/v1/assets/generated-1/content", error: null },
          { slotId: "slot-2", slotNumber: 2, role: "detail", status: "succeeded", attempt: 1, archivedAssetId: "generated-2", localUrl: "/api/v1/assets/generated-2/content", error: null },
          { slotId: "slot-3", slotNumber: 3, role: "scene", status: "failed", attempt: 1, archivedAssetId: null, localUrl: null, error: "timeout" }
        ]
      })]
    });

    const result = await new ProductService({ query }).get("prod_1");

    expect(result?.imageGeneration?.slots).toEqual(expect.arrayContaining([
      expect.objectContaining({ slotId: "slot-1", acceptedOrder: 2 }),
      expect.objectContaining({ slotId: "slot-2", acceptedOrder: 1 }),
      expect.objectContaining({ slotId: "slot-3", acceptedOrder: null })
    ]));
  });

  it("derives partial progress from persisted slots", async () => {
    const query = vi.fn().mockResolvedValue({
      rows: [workspaceRow({
        batch_id: "batch_partial",
        batch_state: "generating",
        batch_category_key: "apparel",
        batch_requested_output_count: 5,
        batch_confirmed_category: "apparel",
        slots_json: [
          { slotId: "slot-1", slotNumber: 1, role: "main", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out-1/content", error: null },
          { slotId: "slot-2", slotNumber: 2, role: "detail", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out-2/content", error: null },
          { slotId: "slot-3", slotNumber: 3, role: "detail", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out-3/content", error: null },
          { slotId: "slot-4", slotNumber: 4, role: "detail", status: "succeeded", attempt: 1, localUrl: "/api/v1/assets/out-4/content", error: null },
          { slotId: "slot-5", slotNumber: 5, role: "detail", status: "running", attempt: 1, localUrl: null, error: null }
        ]
      })]
    });

    const result = await new ProductService({ query }).get("prod_partial");

    expect(result?.imageGeneration).toMatchObject({ requestedCount: 5, successfulCount: 4, state: "partial" });
  });
});
