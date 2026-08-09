import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "@tk/config";

import type { WorkerApplication } from "../entry.js";
import {
  createReloadableWorkerApplication,
  type ResolvedRuntimeCandidate
} from "./reloadable-worker-application.js";

const COUNTERS = Object.freeze({
  canvas: 0,
  llm: 0,
  exchangeRate: 0,
  assetStaging: 0,
  assetPublishing: 0,
  imagePlanner: 0,
  imageGeneration: 0
});

function candidate(version: number): ResolvedRuntimeCandidate {
  return { version, config: { databaseUrl: `postgres://runtime-${version}` } as AppConfig };
}

function generation(processed: number): WorkerApplication & {
  run: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
} {
  return {
    run: vi.fn(async () => ({ processed })),
    counters: () => COUNTERS,
    close: vi.fn(async () => undefined)
  };
}

describe("reloadable worker application", () => {
  it("applies a newer valid version before the next processing cycle", async () => {
    let currentCandidate = candidate(1);
    const first = generation(1);
    const second = generation(2);
    const build = vi.fn(async (value: ResolvedRuntimeCandidate) =>
      value.version === 1 ? first : second
    );
    const markApplied = vi.fn(async () => undefined);
    const application = createReloadableWorkerApplication({
      loadCandidate: async () => currentCandidate,
      build,
      markApplied,
      markRejected: vi.fn(async () => undefined)
    });

    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 1 });
    currentCandidate = candidate(2);
    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 2 });

    expect(build).toHaveBeenLastCalledWith(currentCandidate);
    expect(markApplied).toHaveBeenNthCalledWith(2, 2);
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.run).toHaveBeenCalledWith({ maxJobs: 1 });
  });

  it("keeps the last valid application after rejecting an invalid candidate once", async () => {
    let currentCandidate = candidate(1);
    const first = generation(0);
    const build = vi.fn(async (value: ResolvedRuntimeCandidate) => {
      if (value.version === 3) {
        throw Object.assign(new Error("provider response containing a secret"), {
          code: "image_provider_required"
        });
      }
      return first;
    });
    const markRejected = vi.fn(async () => undefined);
    const application = createReloadableWorkerApplication({
      loadCandidate: async () => currentCandidate,
      build,
      markApplied: vi.fn(async () => undefined),
      markRejected
    });

    await application.run({ maxJobs: 1 });
    currentCandidate = candidate(3);
    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 0 });
    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 0 });

    expect(first.run).toHaveBeenCalledTimes(3);
    expect(build).toHaveBeenCalledTimes(2);
    expect(markRejected).toHaveBeenCalledOnce();
    expect(markRejected).toHaveBeenCalledWith(3, "image_provider_required");
  });

  it("treats the initial construction failure as fatal and stores only a safe code", async () => {
    const closeLoader = vi.fn(async () => undefined);
    const markRejected = vi.fn(async () => undefined);
    const failure = Object.assign(new Error("secret-bearing provider failure"), {
      code: "not safe: provider-secret"
    });
    const application = createReloadableWorkerApplication({
      loadCandidate: async () => candidate(1),
      build: vi.fn(async () => { throw failure; }),
      markApplied: vi.fn(async () => undefined),
      markRejected,
      closeLoader
    });

    await expect(application.run()).rejects.toBe(failure);
    expect(markRejected).toHaveBeenCalledWith(1, "runtime_configuration_invalid");
    await application.close();
    await application.close();
    expect(closeLoader).toHaveBeenCalledOnce();
  });

  it("keeps the last valid application when resolving a saved candidate fails", async () => {
    const first = generation(1);
    let failLoading = false;
    const loadCandidate = vi.fn(async () => {
      if (failLoading) {
        throw Object.assign(new Error("runtime configuration secrets could not be decrypted"), {
          candidateVersion: 2,
          code: "runtime_configuration_secrets_invalid"
        });
      }
      return candidate(1);
    });
    const markRejected = vi.fn(async () => undefined);
    const application = createReloadableWorkerApplication({
      loadCandidate,
      build: vi.fn(async () => first),
      markApplied: vi.fn(async () => undefined),
      markRejected
    });

    await application.run();
    failLoading = true;
    await expect(application.run()).resolves.toEqual({ processed: 1 });
    await expect(application.run()).resolves.toEqual({ processed: 1 });

    expect(first.run).toHaveBeenCalledTimes(3);
    expect(markRejected).toHaveBeenCalledOnce();
    expect(markRejected).toHaveBeenCalledWith(2, "runtime_configuration_secrets_invalid");
  });

  it("closes the active generation and loader exactly once", async () => {
    const active = generation(0);
    const closeLoader = vi.fn(async () => undefined);
    const application = createReloadableWorkerApplication({
      loadCandidate: async () => candidate(1),
      build: vi.fn(async () => active),
      markApplied: vi.fn(async () => undefined),
      markRejected: vi.fn(async () => undefined),
      closeLoader
    });

    await application.run();
    await application.close();
    await application.close();

    expect(active.close).toHaveBeenCalledOnce();
    expect(closeLoader).toHaveBeenCalledOnce();
  });
});
