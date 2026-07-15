import { describe, expect, it, vi } from "vitest";

import { runWorkerProcess } from "./cli.js";

describe("worker executable", () => {
  it("starts the composed application, consumes queued work, and closes cleanly", async () => {
    const run = vi.fn(async () => ({ processed: 1 }));
    const close = vi.fn(async () => undefined);

    await runWorkerProcess({
      application: { run, counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 }), close },
      maxCycles: 1,
      pollIntervalMs: 1
    });

    expect(run).toHaveBeenCalledWith({ maxJobs: 100 });
    expect(close).toHaveBeenCalledOnce();
  });
});
