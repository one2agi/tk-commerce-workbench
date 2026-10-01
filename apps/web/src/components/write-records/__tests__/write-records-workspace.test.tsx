import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { WriteRecordsOverviewV1 } from "@tk/contracts/read-models";
import { WriteRecordsWorkspace } from "../write-records-workspace";


afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mockData: WriteRecordsOverviewV1 = {
  items: [
    {
      syncId: "sync_001",
      approvalSnapshotId: "snap_001",
      state: "succeeded",
      remoteDetailId: "3814610360" as never,
      lastReconciledAt: "2026-10-01T08:00:00.000Z",
      error: null,
      productId: "prod_hat_01",
      title: "民族风手工编织遮阳草帽",
      thumbnailUrl: "/api/v1/assets/asset_1/content?variant=thumbnail",
      sourceCanonicalUrl: "https://detail.1688.com/offer/1016094589470.html",
      sourcePlatform: "1688",
      imageCount: 5
    },
    {
      syncId: "sync_002",
      approvalSnapshotId: "snap_002",
      state: "failed",
      remoteDetailId: null,
      lastReconciledAt: "2026-10-01T08:30:00.000Z",
      error: { kind: "retryable", code: "weight_invalid", safeMessage: "重量不能小于0.01kg" },
      productId: "prod_vase_02",
      title: "极简北欧陶瓷手办摆件",
      thumbnailUrl: null,
      sourcePlatform: "1688",
      imageCount: 4
    }
  ],
  metrics: {
    todayCollected: 12,
    todayWritten: 10,
    todaySuccess: 8,
    todayFailed: 2,
    todayImages: 40
  },
  generationRecords: [
    {
      batchId: "batch_gen_001",
      productId: "prod_hat_01",
      title: "民族风手工编织遮阳草帽",
      categoryKey: "服饰箱包 / 帽子",
      requestedCount: 5,
      successfulCount: 5,
      state: "succeeded",
      providerRoute: "SiliconFlow / Qwen3-VL-8B + Z-Image",
      createdAt: "2026-10-01T07:50:00.000Z"
    }
  ]
};

describe("WriteRecordsWorkspace", () => {
  it("renders Bento metrics and double-bezel cards with Taste Soft styling", () => {
    render(<WriteRecordsWorkspace data={mockData} />);

    expect(screen.getByText("写入记录与算力流水")).toBeInTheDocument();
    expect(screen.getByText("MIAOSHOU ERP · SYNC & GENERATION LEDGER")).toBeInTheDocument();

    // Bento metrics
    expect(screen.getByText("今日采集")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
    expect(screen.getByText("今日写入")).toBeInTheDocument();
    expect(screen.getByText("10")).toBeInTheDocument();
    expect(screen.getByText("今日成功")).toBeInTheDocument();
    expect(screen.getByText("8")).toBeInTheDocument();
    expect(screen.getByText("今日失败")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
    expect(screen.getByText("今日生图")).toBeInTheDocument();
    expect(screen.getByText("40")).toBeInTheDocument();

    // Primary items
    expect(screen.getByText("民族风手工编织遮阳草帽")).toBeInTheDocument();
    expect(screen.getByText("极简北欧陶瓷手办摆件")).toBeInTheDocument();
    expect(screen.getByText("3814610360")).toBeInTheDocument();
    expect(screen.getByText("重量不能小于0.01kg")).toBeInTheDocument();
  });

  it("filters items by search input", () => {
    render(<WriteRecordsWorkspace data={mockData} />);

    const searchInput = screen.getByPlaceholderText("搜索商品名称 / ID...");
    fireEvent.change(searchInput, { target: { value: "草帽" } });

    expect(screen.getByText("民族风手工编织遮阳草帽")).toBeInTheDocument();
    expect(screen.queryByText("极简北欧陶瓷手办摆件")).not.toBeInTheDocument();
  });

  it("filters items by status dropdown", () => {
    render(<WriteRecordsWorkspace data={mockData} />);

    const select = screen.getByRole("combobox");
    fireEvent.change(select, { target: { value: "failed" } });

    expect(screen.queryByText("民族风手工编织遮阳草帽")).not.toBeInTheDocument();
    expect(screen.getByText("极简北欧陶瓷手办摆件")).toBeInTheDocument();
  });

  it("switches to generation records tab and displays AI audit details", () => {
    render(<WriteRecordsWorkspace data={mockData} />);

    const genTabBtn = screen.getByRole("button", { name: /生成记录/ });
    fireEvent.click(genTabBtn);

    expect(screen.getByText("调用线路 / 算力模型")).toBeInTheDocument();
    expect(screen.getByText("SiliconFlow / Qwen3-VL-8B + Z-Image")).toBeInTheDocument();
    expect(screen.getByText("要 5 · 成功 5")).toBeInTheDocument();
    expect(screen.getByText("100% 满图")).toBeInTheDocument();
  });

  it("calls retry API when clicking retry button on failed item", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true })
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<WriteRecordsWorkspace data={mockData} />);

    const retryButtons = screen.getAllByRole("button", { name: "重写" });
    expect(retryButtons.length).toBeGreaterThan(0);

    fireEvent.click(retryButtons[1]); // retry failed item

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/v1/products/prod_vase_02/retry-miaoshou-edit",
        expect.objectContaining({ method: "POST" })
      );
    });

    expect(screen.getByText("已重新触发写入任务，正在同步...")).toBeInTheDocument();
  });
});
