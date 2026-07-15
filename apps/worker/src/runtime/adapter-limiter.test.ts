import { describe, expect, it } from "vitest";
import { AdapterLimiterSet } from "./adapter-limiter.js";

describe("AdapterLimiterSet", () => {
  it("bounds each adapter independently", async () => {
    const limiters = new AdapterLimiterSet({ llm: { concurrency: 1, minIntervalMs: 0 }, canvas: { concurrency: 1, minIntervalMs: 0 } });
    let activeLlm = 0;
    let maxLlm = 0;
    let canvasObservedWhileLlmActive = false;
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = limiters.run("llm", async () => {
      activeLlm++;
      maxLlm = Math.max(maxLlm, activeLlm);
      await firstBlocked;
      activeLlm--;
    });
    const second = limiters.run("llm", async () => {
      activeLlm++;
      maxLlm = Math.max(maxLlm, activeLlm);
      activeLlm--;
    });
    await limiters.run("canvas", async () => { canvasObservedWhileLlmActive = activeLlm === 1; });
    releaseFirst();
    await Promise.all([first, second]);
    expect(maxLlm).toBe(1);
    expect(canvasObservedWhileLlmActive).toBe(true);
  });
});
