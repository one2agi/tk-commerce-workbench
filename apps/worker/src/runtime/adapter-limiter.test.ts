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

  it("serializes start times even when adapter concurrency is greater than one", async () => {
    const limiters = new AdapterLimiterSet({ canvas: { concurrency: 2, minIntervalMs: 20 } });
    const starts: number[] = [];
    await Promise.all([
      limiters.run("canvas", async () => { starts.push(Date.now()); }),
      limiters.run("canvas", async () => { starts.push(Date.now()); })
    ]);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(15);
  });

  it("image_generate_slot: blocks third concurrent call until one of first two releases", async () => {
    const limiters = new AdapterLimiterSet({ "imageGeneration:openai-dall-e-3": { concurrency: 2, minIntervalMs: 0 } });
    // Use shared gates so first+second hold slots open until we release them
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const gate1 = new Promise<void>((r) => { releaseFirst = r; });
    const gate2 = new Promise<void>((r) => { releaseSecond = r; });
    const order: string[] = [];

    const op = async (label: string, gate: Promise<void>) =>
      limiters.run("imageGeneration:openai-dall-e-3", async () => {
        order.push(`${label}:start`);
        await gate;
        order.push(`${label}:end`);
      });

    // Start first two — both acquire slots immediately, then block on their gates
    const first = op("first", gate1);
    const second = op("second", gate2);

    // Wait one tick for both to acquire their slots
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    expect(order.filter((s) => s === "first:start")).toHaveLength(1);
    expect(order.filter((s) => s === "second:start")).toHaveLength(1);

    // Third should be blocked because both slots are held by first+second
    let thirdDidRun = false;
    const third = op("third", Promise.resolve()).then(() => { thirdDidRun = true; });

    // Give the event loop a tick — third must not have run yet
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    expect(thirdDidRun).toBe(false);

    // Release second — third can now acquire the freed slot
    releaseSecond();
    await third;
    expect(thirdDidRun).toBe(true);

    // Clean up first
    releaseFirst();
    await first;
    await second;
  });
});
