import { describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import type { PublicServiceConfigurationV1 } from "../../../packages/contracts/src/runtime-configuration.js";

import { createRuntimeConfiguredWorkerApplication, runWorkerProcess } from "./cli.js";

const SAVED_PUBLIC_CONFIG: PublicServiceConfigurationV1 = {
  imageGenerationPath: "headless",
  imagePlannerBaseUrl: "https://planner.saved/v1",
  imagePlannerModel: "planner-saved",
  imageProviderBaseUrl: "https://images.saved/v1",
  imageProviderModel: "image-saved",
  canvasBaseUrl: "",
  canvasId: "canvas-saved",
  canvasWorkflowName: "workflow-saved",
  llmBaseUrl: "https://llm.saved/v1",
  llmModel: "llm-saved",
  exchangeRateBaseUrl: "https://rates.saved",
  miaoshouBaseUrl: "https://miaoshou.saved",
  miaoshouAccountId: "account-saved",
  assetPublishS3Endpoint: "",
  assetPublishS3Region: "",
  assetPublishS3Bucket: "",
  assetPublishPublicBaseUrl: ""
};

describe("worker executable", () => {
  it("seeds once, builds from the saved candidate, and owns loader cleanup", async () => {
    const envelope = { version: 1 as const, nonce: "nonce", tag: "tag", ciphertext: "ciphertext" };
    const seedEnvelope = { version: 1 as const, nonce: "seed-nonce", tag: "seed-tag", ciphertext: "seed-ciphertext" };
    const seedIfMissing = vi.fn(async () => undefined);
    const loadAppliedCandidate = vi.fn(async () => undefined);
    const loadCandidate = vi.fn(async () => ({
      version: 7,
      publicConfig: SAVED_PUBLIC_CONFIG,
      encryptedSecrets: envelope,
      runtimeConfig: {
        externalAdapterMode: "mock" as "mock" | "live",
        workerConcurrency: 4,
        maxCanvasRunsPerDay: 75,
        retryPolicy: { maxAttempts: 5, initialDelaySeconds: 45 }
      }
    }));
    const markApplied = vi.fn(async () => undefined);
    const markRejected = vi.fn(async () => undefined);
    const loaderEnd = vi.fn(async () => undefined);
    const generationCloses: Array<ReturnType<typeof vi.fn>> = [];
    const build = vi.fn(async () => {
      const close = vi.fn(async () => undefined);
      generationCloses.push(close);
      return {
        run: vi.fn(async () => ({ processed: 1 })),
        counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0, assetPublishing: 0, imagePlanner: 0, imageGeneration: 0 }),
        close
      };
    });
    const seal = vi.fn(() => seedEnvelope);
    const open = vi.fn(() => ({
      imagePlannerApiKey: "planner-secret",
      imageProviderApiKey: "provider-secret",
      llmApiKey: "llm-secret",
      miaoshouAppKey: "miaoshou-key",
      miaoshouAppSecret: "miaoshou-secret",
      extensionToken: "saved-extension-token"
    }));

    const application = createRuntimeConfiguredWorkerApplication({
      env: {
        NODE_ENV: "production",
        EXTERNAL_ADAPTER_MODE: "mock",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
        TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
        LOCAL_OPERATOR_ID: "local-operator",
        EXTENSION_TOKEN: "legacy-extension-token",
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64"),
        CANVAS_BASE_URL: "https://canvas.legacy"
      },
      dependencies: {
        createPool: vi.fn(() => ({ query: vi.fn(), connect: vi.fn(), on: vi.fn(), end: loaderEnd }) as never),
        createRepository: vi.fn(() => ({ seedIfMissing, loadAppliedCandidate, loadCandidate, markApplied, markRejected })),
        createSecretCodec: vi.fn(() => ({ seal, open })),
        build
      }
    });

    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 1 });
    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 1 });

    expect(seedIfMissing).toHaveBeenCalledOnce();
    expect(seedIfMissing).toHaveBeenCalledWith(expect.objectContaining({
      publicConfig: expect.objectContaining({ imageGenerationPath: "canvas", canvasBaseUrl: "https://canvas.legacy" }),
      encryptedSecrets: seedEnvelope,
      runtimeConfig: {
        externalAdapterMode: "mock", workerConcurrency: 2, maxCanvasRunsPerDay: 50,
        retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 }
      }
    }));
    expect(seal).toHaveBeenCalledWith(expect.objectContaining({ extensionToken: "legacy-extension-token" }), "workspace_settings:1");
    expect(open).toHaveBeenCalledWith(envelope, "workspace_settings:1");
    expect(build).toHaveBeenCalledOnce();
    expect(build).toHaveBeenCalledWith(expect.objectContaining({
      version: 7,
      config: expect.objectContaining({
        imageGenerationPath: "headless",
        imagePlannerApiKey: "planner-secret",
        imageProviderApiKey: "provider-secret",
        extensionToken: "saved-extension-token",
        externalAdapterMode: "mock",
        workerConcurrency: 4,
        maxCanvasRunsPerDay: 75,
        retryPolicy: { maxAttempts: 5, initialDelaySeconds: 45 }
      })
    }));
    expect(markApplied).toHaveBeenCalledWith(expect.objectContaining({
      version: 7,
      encryptedSecrets: envelope,
      runtimeConfig: expect.objectContaining({ retryPolicy: { maxAttempts: 5, initialDelaySeconds: 45 } })
    }));

    loadCandidate.mockResolvedValue({
      version: 8,
      publicConfig: SAVED_PUBLIC_CONFIG,
      encryptedSecrets: envelope,
      runtimeConfig: {
        externalAdapterMode: "live", workerConcurrency: 8, maxCanvasRunsPerDay: 120,
        retryPolicy: { maxAttempts: 8, initialDelaySeconds: 80 }
      }
    });
    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 1 });
    expect(build).toHaveBeenLastCalledWith(expect.objectContaining({
      version: 8,
      config: expect.objectContaining({
        externalAdapterMode: "live",
        workerConcurrency: 8,
        maxCanvasRunsPerDay: 120,
        retryPolicy: { maxAttempts: 8, initialDelaySeconds: 80 }
      })
    }));

    loadCandidate.mockResolvedValue({
      version: 9,
      publicConfig: SAVED_PUBLIC_CONFIG,
      encryptedSecrets: envelope,
      runtimeConfig: {
        externalAdapterMode: "live", workerConcurrency: 9, maxCanvasRunsPerDay: 121,
        retryPolicy: { maxAttempts: 9, initialDelaySeconds: 90 }
      }
    });
    open.mockImplementationOnce(() => {
      throw new Error("runtime configuration secrets could not be decrypted");
    });
    await expect(application.run({ maxJobs: 1 })).resolves.toEqual({ processed: 1 });
    expect(markRejected).toHaveBeenCalledWith(9, "runtime_configuration_secrets_invalid");

    await application.close();
    await application.close();
    expect(generationCloses).toHaveLength(2);
    expect(generationCloses[0]).toHaveBeenCalledOnce();
    expect(generationCloses[1]).toHaveBeenCalledOnce();
    expect(loaderEnd).toHaveBeenCalledOnce();
  });

  it("restores the persisted last-known-good candidate before trying a bad latest version", async () => {
    const appliedEnvelope = { version: 1 as const, nonce: "applied-nonce", tag: "tag", ciphertext: "applied" };
    const latestEnvelope = { version: 1 as const, nonce: "latest-nonce", tag: "tag", ciphertext: "latest" };
    const runtimeConfig = {
      externalAdapterMode: "mock" as const,
      workerConcurrency: 3,
      maxCanvasRunsPerDay: 60,
      retryPolicy: { maxAttempts: 4, initialDelaySeconds: 75 }
    };
    const applied = { version: 4, publicConfig: SAVED_PUBLIC_CONFIG, encryptedSecrets: appliedEnvelope, runtimeConfig };
    const latest = { version: 5, publicConfig: SAVED_PUBLIC_CONFIG, encryptedSecrets: latestEnvelope, runtimeConfig };
    const run = vi.fn(async () => ({ processed: 4 }));
    const close = vi.fn(async () => undefined);
    const markRejected = vi.fn(async () => undefined);
    const open = vi.fn((envelope: typeof appliedEnvelope) => {
      if (envelope.ciphertext === "latest") throw new Error("bad latest ciphertext");
      return { extensionToken: "applied-token" };
    });
    const application = createRuntimeConfiguredWorkerApplication({
      env: {
        NODE_ENV: "production", EXTERNAL_ADAPTER_MODE: "mock",
        DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
        TEST_DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
        LOCAL_OPERATOR_ID: "local-operator",
        CONFIG_ENCRYPTION_KEY: Buffer.alloc(32, 6).toString("base64")
      },
      dependencies: {
        createPool: vi.fn(() => ({ query: vi.fn(), connect: vi.fn(), on: vi.fn(), end: vi.fn(async () => undefined) }) as never),
        createRepository: vi.fn(() => ({
          seedIfMissing: vi.fn(async () => undefined),
          loadAppliedCandidate: vi.fn(async () => applied),
          loadCandidate: vi.fn(async () => latest),
          markApplied: vi.fn(async () => undefined),
          markRejected
        })),
        createSecretCodec: vi.fn(() => ({ seal: vi.fn(() => appliedEnvelope), open })),
        build: vi.fn(async () => ({ run, counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0, assetPublishing: 0, imagePlanner: 0, imageGeneration: 0 }), close }))
      }
    });

    await expect(application.run()).resolves.toEqual({ processed: 4 });
    expect(markRejected).toHaveBeenCalledWith(5, "runtime_configuration_secrets_invalid");
    expect(run).toHaveBeenCalledOnce();
    await application.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it("starts the composed application, consumes queued work, and closes cleanly", async () => {
    const run = vi.fn(async () => ({ processed: 1 }));
    const close = vi.fn(async () => undefined);

    await runWorkerProcess({
      application: { run, counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0, assetPublishing: 0, imagePlanner: 0, imageGeneration: 0 }), close },
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
        counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0, assetPublishing: 0, imagePlanner: 0, imageGeneration: 0 }),
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
        counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0, assetPublishing: 0, imagePlanner: 0, imageGeneration: 0 }),
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

  it("does not leak a connection-string-shaped value when DB termination throws", async () => {
    // Simulates a pg-error path that, in production, would carry the
    // connection string in the message. The worker process must NOT propagate
    // this verbatim through process.stderr because the runtime manager
    // scans worker.log for the userinfo segment and would otherwise trip the
    // sensitive-log fuse.
    const captured: string[] = [];
    const stream = new Writable({
      write(chunk, _enc, cb) {
        captured.push(chunk.toString());
        cb();
      }
    });
    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = stream.write.bind(stream);
    try {
      await expect(
        runWorkerProcess({
          application: {
            run: vi.fn(async () => {
              const error = new Error(
                "connection terminated: postgresql://fixture-user:fixture-pass@127.0.0.1:5432/tk_workbench"
              );
              throw error;
            }),
            counters: () => ({ canvas: 0, llm: 0, exchangeRate: 0, assetStaging: 0, assetPublishing: 0, imagePlanner: 0, imageGeneration: 0 }),
            close: vi.fn(async () => undefined)
          },
          env: {
            TK_RUNTIME_LAUNCH_ID: "launch-leak",
            TK_WORKER_READY_PATH: "/nonexistent/worker-ready-launch-leak.json"
          },
          maxCycles: 1
        })
      ).rejects.toThrow(/connection terminated/);
    } finally {
      process.stderr.write = originalWrite;
    }

    const stderr = captured.join("");
    // The worker may write through its own logger ("worker:" prefix). What
    // matters is that the leaked credential-bearing substring never appears
    // verbatim in stderr.
    expect(stderr).not.toContain("fixture-pass");
    expect(stderr).not.toContain("fixture-user");
    expect(stderr).not.toContain("postgresql://");
  });
});
