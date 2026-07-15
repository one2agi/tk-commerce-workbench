import { describe, expect, it, vi } from "vitest";
import { exchangeRateSnapshotId } from "@tk/contracts";
import { createExchangeRateAdapter } from "./exchange-rate-adapter.js";

describe("exchange rate adapter", () => {
  it("translates a provider CNY to THB snapshot and caches the latest observation", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ base: "CNY", rates: { THB: 4.82 }, timestamp: "2026-07-16T00:00:00.000Z" }), { status: 200 }));
    const adapter = createExchangeRateAdapter({ baseUrl: "https://rates.test", fetchImpl, now: () => "2026-07-16T00:00:00.000Z" });
    await expect(adapter.fetchSnapshot({ base: "CNY", target: "THB" })).resolves.toEqual({ base: "CNY", target: "THB", rate: "4.82", source: "provider", observedAt: "2026-07-16T00:00:00.000Z", isStale: false });
    await expect(adapter.latestSnapshot({ base: "CNY", target: "THB" })).resolves.toMatchObject({ rate: "4.82" });
  });

  it("rejects a non-positive or malformed provider rate", async () => {
    const adapter = createExchangeRateAdapter({ baseUrl: "https://rates.test", fetchImpl: vi.fn(async () => new Response(JSON.stringify({ rates: { THB: 0 } }), { status: 200 })) });
    await expect(adapter.fetchSnapshot({ base: "CNY", target: "THB" })).rejects.toMatchObject({ kind: "fatal", code: "exchange_rate.invalid_response" });
  });

  it("records a manual override without calling the provider", async () => {
    const fetchImpl = vi.fn();
    const adapter = createExchangeRateAdapter({ baseUrl: "https://rates.test", fetchImpl, now: () => "2026-07-16T01:00:00.000Z" });
    await expect(adapter.recordManualOverride({ base: "CNY", target: "THB", rate: "4.90", snapshotId: exchangeRateSnapshotId("rate_manual_01") })).resolves.toMatchObject({ rate: "4.90", source: "manual" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
