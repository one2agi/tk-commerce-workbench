// RED — phase 3 (api-client dispatch + forbidden surface)
// Clicking "开始处理" / "批量开始处理（N）" must dispatch a StartAutomationV1
// payload (the only human-gate command permitted in Wave 1). It must never
// expose "发布 TikTok", "认领到采集箱" or Miaoshou-edit buttons.

import { describe, expect, it, vi } from "vitest";
import {
  createHttpApiClient,
  dispatchBatchProductAction,
  dispatchStartAutomation,
  fetchProductPool,
  summarizeBatchProductActionResult,
  type ApiClient
} from "../../lib/api-client";
import { StartAutomationV1 } from "@tk/contracts/commands";

describe("api-client.startAutomation dispatch", () => {
  it("dispatches a version-1 StartAutomationV1 payload with revisionIds", async () => {
    const send = vi.fn().mockResolvedValue({ runs: [] });
    const client: ApiClient = { send };
    await dispatchStartAutomation(client, {
      revisionIds: ["rev-1", "rev-2"]
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [command, payload] = send.mock.calls[0]!;
    expect(command).toBe("StartAutomationV1");
    const parsed = StartAutomationV1.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("rejects payloads that don't match the contract shape", async () => {
    const send = vi.fn().mockResolvedValue({ runs: [] });
    const client: ApiClient = { send };
    await expect(
      dispatchStartAutomation(client, {
        revisionIds: [] // empty array fails .min(1)
      })
    ).rejects.toThrow();
  });

  it("uses the local automation endpoint in the default HTTP client", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      runs: [{ revisionId: "rev-1", runId: "run-1", created: true }]
    }), { status: 202, headers: { "content-type": "application/json" } }));

    await expect(dispatchStartAutomation(createHttpApiClient(fetcher), {
      revisionIds: ["rev-1"]
    })).resolves.toMatchObject({ runs: [{ runId: "run-1" }] });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/automation-runs", expect.objectContaining({
      method: "POST"
    }));
  });
});

describe("api-client.batchProductAction dispatch", () => {
  it("uses the controlled local batch action endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({
      results: [{ productId: "product-1", ok: true }]
    }, { status: 202 }));

    await expect(dispatchBatchProductAction(fetcher, {
      action: "confirm_miaoshou_edit",
      productIds: ["product-1"]
    })).resolves.toMatchObject({ results: [{ productId: "product-1", ok: true }] });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/products/batch-actions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ action: "confirm_miaoshou_edit", productIds: ["product-1"] })
    }));
  });

  it("does not expose a TikTok publish batch action", async () => {
    const source = await import("../../lib/api-client");
    expect(Object.keys(source).join("\n")).not.toMatch(/publish|claim|TikTok/i);
  });

  it("loads the latest product pool through the controlled local endpoint", async () => {
    const fetcher = vi.fn(async () => Response.json({
      items: [{ productId: "product-1", automation: "queued" }]
    }));

    await expect(fetchProductPool(fetcher)).resolves.toMatchObject({
      items: [{ productId: "product-1", automation: "queued" }]
    });
    expect(fetcher).toHaveBeenCalledWith("/api/v1/products", expect.objectContaining({
      method: "GET"
    }));
  });

  it("summarizes mixed batch results in product-facing Chinese", () => {
    expect(summarizeBatchProductActionResult("批量确认写回", {
      results: [
        { productId: "product-a", ok: true },
        { productId: "product-b", ok: false, code: "approval_preview_not_ready" }
      ]
    })).toBe("批量确认写回：1 个成功，1 个失败（product-b：审批快照尚未准备好）");
  });
});
