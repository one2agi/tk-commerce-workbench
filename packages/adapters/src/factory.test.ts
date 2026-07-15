import { describe, expect, it, vi } from "vitest";
import { createAdapterBundle } from "./factory.js";

const mockConfig = { externalAdapterMode: "mock" as const, nodeEnv: "development" as const, assetRoot: "./data/assets" };

describe("adapter bundle factory cost boundary", () => {
  it("returns deterministic fakes in mock mode without constructing a network client", () => {
    const constructLive = vi.fn(() => { throw new Error("must not construct live"); });
    const bundle = createAdapterBundle(mockConfig, undefined, { constructLive });
    expect(bundle.mode).toBe("mock");
    expect(bundle.counters()).toEqual({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 });
    expect(constructLive).not.toHaveBeenCalled();
  });

  it("counts deterministic mock calls without touching a network", async () => {
    const bundle = createAdapterBundle(mockConfig);
    await bundle.canvas.readWorkflowCapacity("workflow_1");
    await bundle.exchangeRate.latestSnapshot({ base: "CNY", target: "THB" });
    expect(bundle.counters()).toEqual({ canvas: 1, llm: 0, exchangeRate: 1, assetStaging: 0 });
  });

  it.each(["test", "integration", "e2e"] as const)("fails closed for live mode in %s", (processKind) => {
    expect(() => createAdapterBundle({ ...mockConfig, externalAdapterMode: "live", processKind }, { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" })).toThrow(/refusing live adapters/i);
  });

  it("requires an explicit stable command context before constructing live clients", () => {
    const constructLive = vi.fn();
    expect(() => createAdapterBundle({ ...mockConfig, externalAdapterMode: "live", nodeEnv: "production" }, undefined, { constructLive })).toThrow(/command context/i);
    expect(constructLive).not.toHaveBeenCalled();
  });

  it("constructs live adapters only after a valid command context", () => {
    const sentinel = createAdapterBundle(mockConfig);
    const constructLive = vi.fn(() => ({ ...sentinel, mode: "live" as const }));
    const result = createAdapterBundle({ ...mockConfig, externalAdapterMode: "live", nodeEnv: "production" }, { kind: "worker_command", commandId: "command_123", idempotencyKey: "stable:key:123" }, { constructLive });
    expect(result.mode).toBe("live");
    expect(constructLive).toHaveBeenCalledTimes(1);
  });
});
