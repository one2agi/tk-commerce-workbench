// RED — phase 3 (api-client dispatch + forbidden surface)
// Clicking "开始处理" / "批量开始处理（N）" must dispatch a StartAutomationV1
// payload (the only human-gate command permitted in Wave 1). It must never
// expose "发布 TikTok", "认领到采集箱" or Miaoshou-edit buttons.

import { describe, expect, it, vi } from "vitest";
import {
  createHttpApiClient,
  dispatchStartAutomation,
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
