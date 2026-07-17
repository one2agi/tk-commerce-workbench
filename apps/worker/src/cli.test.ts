import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

  it("writes an atomic launch-bound readiness proof only after a successful database-backed cycle", async () => {
    const root = await mkdtemp(join(tmpdir(), "tk-worker-ready-"));
    const readyPath = join(root, "worker-ready-launch-123.json");
    const close = vi.fn(async () => undefined);

    await runWorkerProcess({
      application: {
        run: vi.fn(async () => ({ processed: 0 })),
        counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 }),
        close
      },
      env: {
        TK_RUNTIME_LAUNCH_ID: "launch-123",
        TK_WORKER_READY_PATH: readyPath
      },
      maxCycles: 1
    });

    expect(JSON.parse(await readFile(readyPath, "utf8"))).toEqual({
      launchId: "launch-123",
      pid: process.pid
    });
    expect(close).toHaveBeenCalledOnce();
  });

  it("does not write readiness when the first database-backed cycle fails", async () => {
    const root = await mkdtemp(join(tmpdir(), "tk-worker-not-ready-"));
    const readyPath = join(root, "worker-ready-launch-456.json");

    await expect(runWorkerProcess({
      application: {
        run: vi.fn(async () => { throw new Error("database unavailable"); }),
        counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0 }),
        close: vi.fn(async () => undefined)
      },
      env: {
        TK_RUNTIME_LAUNCH_ID: "launch-456",
        TK_WORKER_READY_PATH: readyPath
      },
      maxCycles: 1
    })).rejects.toThrow("database unavailable");
    await expect(readFile(readyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
