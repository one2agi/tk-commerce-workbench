// RED — phase 3 (api-client dispatch + forbidden surface)
// Clicking "开始处理" / "批量开始处理（N）" must dispatch a StartAutomationV1
// payload (the only human-gate command permitted in Wave 1). It must never
// expose "发布 TikTok", "认领到采集箱" or Miaoshou-edit buttons.

import { describe, expect, it, vi } from "vitest";
import { dispatchStartAutomation, type ApiClient } from "../../lib/api-client";
import { StartAutomationV1 } from "@tk/contracts/commands";

describe("api-client.startAutomation dispatch", () => {
  it("dispatches a version-1 StartAutomationV1 payload with revisionIds", () => {
    const send = vi.fn().mockReturnValue({ accepted: true });
    const client: ApiClient = { send } as unknown as ApiClient;
    dispatchStartAutomation(client, {
      revisionIds: ["rev-1", "rev-2"]
    });
    expect(send).toHaveBeenCalledTimes(1);
    const [command, payload] = send.mock.calls[0]!;
    expect(command).toBe("StartAutomationV1");
    const parsed = StartAutomationV1.safeParse(payload);
    expect(parsed.success).toBe(true);
  });

  it("rejects payloads that don't match the contract shape", () => {
    const send = vi.fn().mockReturnValue({ accepted: true });
    const client: ApiClient = { send } as unknown as ApiClient;
    expect(() =>
      dispatchStartAutomation(client, {
        revisionIds: [] // empty array fails .min(1)
      })
    ).toThrow();
  });
});