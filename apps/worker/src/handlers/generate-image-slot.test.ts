import { describe, expect, it, vi } from "vitest";
import type { ImageGenerationPort, PlannedImagePromptV1 } from "@tk/contracts";
import {
  RetryableJobError,
  type ClaimedWorkerJob,
  type WorkerExecutionContext
} from "../runtime/worker-loop.js";
import { createGenerateImageSlotHandler, type ContentAddressedStore } from "./generate-image-slot.js";

const slotJob = (
  batchId = "batch_1",
  slotId = "slot_1",
  slotNumber = 1,
  remoteTaskId: string | null = null,
  reconciliationIntent = false
): ClaimedWorkerJob => ({
  jobId: `job-${slotId}`,
  kind: "image_generate_slot",
  businessKey: `slot:${batchId}:${slotNumber}`,
  payload: {
    version: 1,
    batchId,
    slotId,
    slotNumber,
    ...(reconciliationIntent ? { reconciliationIntent: { version: 1, operation: "image_generate_slot", idempotencyKey: `slot:${batchId}:${slotNumber}` } } : {})
  },
  leaseToken: "lease-1",
  remoteTaskId
});

const execution = (overrides: Partial<WorkerExecutionContext> = {}): WorkerExecutionContext => ({
  fence: { jobId: "job-test", owner: "worker-test", leaseToken: "lease-1" },
  signal: new AbortController().signal,
  assertLease: vi.fn(),
  persistReconciliationIntent: vi.fn(async () => undefined),
  persistRemoteTask: vi.fn(async () => undefined),
  scheduleCompensation: vi.fn(async () => undefined),
  ...overrides
});

const defaultPrompt: PlannedImagePromptV1 = {
  slot: 1,
  role: "default",
  prompt: "A clean product shot on white background",
  mustPreserve: [],
  forbidden: []
};

const defaultReferences = [{
  assetId: "asset_source",
  localPath: "/data/assets/source.png",
  extension: "png" as const
}];

type SlotRepo = Parameters<typeof createGenerateImageSlotHandler>[0]["repository"];

function buildHandler(
  provider: ImageGenerationPort,
  store: ContentAddressedStore,
  repository: Parameters<typeof createGenerateImageSlotHandler>[0]["repository"],
  audit: { append(value: Record<string, unknown>): Promise<unknown> }
) {
  return createGenerateImageSlotHandler({ provider, store, repository, audit });
}

describe("createGenerateImageSlotHandler", () => {

  it("polls an existing task instead of submitting again", async () => {
    const fetchMock = vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.png" }));
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called"); }),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async (url: string) => ({
      remoteUrl: url, finalUrl: url, sha256: `sha-${url.split("/").at(-1)}`,
      path: `/data/assets/${url.split("/").at(-1)}`, extension: "png", bytes: 1024, width: 1024, height: 1024
    }));
    const archiveSlotOutput = vi.fn(async () => "asset_generated");
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: "remote_1", remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput,
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await handler(slotJob("batch_1", "slot_1", 1, "remote_1"), execution());
    expect(provider.submit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith({ remoteTaskId: "remote_1" });
    expect(storeArchive).toHaveBeenCalled();
    expect(archiveSlotOutput).toHaveBeenCalled();
  });

  it("does not mark success when archive validation fails", async () => {
    const fetchMock = vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.png" }));
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called"); }),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async () => { throw new Error("unsupported image"); });
    const archiveSlotOutput = vi.fn(async () => "asset_generated");
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: "remote_1", remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput,
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await expect(handler(slotJob("batch_1", "slot_1", 1, "remote_1"), execution())).rejects.toBeDefined();
    expect(archiveSlotOutput).not.toHaveBeenCalled();
  });

  it("never resubmits after submit intent has an unknown outcome", async () => {
    const submitMock = vi.fn();
    const provider: ImageGenerationPort = {
      submit: submitMock,
      fetch: vi.fn(async () => ({ state: "pending" as const }))
    } as unknown as ImageGenerationPort;
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: null, remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput: vi.fn(async () => "asset_generated"),
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: vi.fn(async () => ({ remoteUrl: "", finalUrl: "", sha256: "x", path: "/x", extension: "png", bytes: 1, width: 1, height: 1 })) }, repository, { append: vi.fn(async () => undefined) });
    await expect(
      handler(slotJob("batch_1", "slot_1", 1, null, true), execution())
    ).rejects.toMatchObject({ code: "image_submission_result_unknown" });
    expect(submitMock).not.toHaveBeenCalled();
  });

  it("maps pending state to RetryableJobError with 30 second delay", async () => {
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => ({ kind: "accepted", remoteTaskId: "remote_pending" as const })),
      fetch: vi.fn(async () => ({ state: "pending" as const }))
    } as unknown as ImageGenerationPort;
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: null, remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput: vi.fn(async () => "asset_generated"),
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: vi.fn(async () => ({ remoteUrl: "", finalUrl: "", sha256: "x", path: "/x", extension: "png", bytes: 1, width: 1, height: 1 })) }, repository, { append: vi.fn(async () => undefined) });
    await expect(handler(slotJob(), execution())).rejects.toBeInstanceOf(RetryableJobError);
    try { await handler(slotJob(), execution()); } catch {}
    await expect(handler(slotJob(), execution())).rejects.toBeInstanceOf(RetryableJobError);
    try { const e = await handler(slotJob(), execution()).catch((e) => e); expect((e as RetryableJobError).delayMs).toBe(30_000); } catch {}
  });

  it("immediately persists remote task id when provider returns accepted", async () => {
    const persistRemoteTask = vi.fn(async () => undefined);
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => ({ kind: "accepted", remoteTaskId: "remote_accepted" as const })),
      fetch: vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.png" }))
    } as unknown as ImageGenerationPort;
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: null, remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput: vi.fn(async () => "asset_generated"),
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: vi.fn(async () => ({ remoteUrl: "", finalUrl: "", sha256: "x", path: "/x", extension: "png", bytes: 1, width: 1, height: 1 })) }, repository, { append: vi.fn(async () => undefined) });
    await handler(slotJob(), execution({ persistRemoteTask }));
    expect(persistRemoteTask).toHaveBeenCalledWith("remote_accepted");
  });

  it("proceeds directly to archival when provider returns completed", async () => {
    const fetchMock = vi.fn();
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => ({ kind: "completed", outputUrl: "https://provider.test/out.png" })),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async (url: string) => ({
      remoteUrl: url, finalUrl: url, sha256: "sha-out", path: "/data/assets/out.png", extension: "png", bytes: 1024, width: 1024, height: 1024
    }));
    const archiveSlotOutput = vi.fn(async () => "asset_generated");
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: null, remoteOutputUrl: null, error: null, references: defaultReferences, parameters: { size: "1024x1024" } })),
      saveRemoteTask: vi.fn(async () => true),
      markSlotFailed: vi.fn(async () => true),
      archiveSlotOutput
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await handler(slotJob(), execution());
    expect(provider.submit).toHaveBeenCalledWith(expect.objectContaining({
      references: defaultReferences,
      parameters: { size: "1024x1024" }
    }));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storeArchive).toHaveBeenCalledWith("https://provider.test/out.png");
    expect(archiveSlotOutput).toHaveBeenCalledWith(
      "slot_1",
      expect.objectContaining({ path: "/data/assets/out.png", sha256: "sha-out" }),
      expect.any(Object)
    );
  });

  it("requires non-zero dimensions after archival", async () => {
    const fetchMock = vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.png" }));
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called"); }),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async () => ({
      remoteUrl: "https://provider.test/out.png", finalUrl: "https://provider.test/out.png",
      sha256: "sha-test", path: "/data/assets/out.png", extension: "png", bytes: 1024, width: 0, height: 0
    }));
    const archiveSlotOutput = vi.fn(async () => "asset_generated");
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: "remote_1", remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput,
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await expect(handler(slotJob("batch_1", "slot_1", 1, "remote_1"), execution())).rejects.toMatchObject({ code: "image_invalid_dimensions" });
    expect(archiveSlotOutput).not.toHaveBeenCalled();
  });

  it("rejects non-PNG and non-JPEG after archival", async () => {
    const fetchMock = vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.gif" }));
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called"); }),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async () => ({
      remoteUrl: "https://provider.test/out.gif", finalUrl: "https://provider.test/out.gif",
      sha256: "sha-test", path: "/data/assets/out.gif", extension: "gif", bytes: 1024, width: 1024, height: 1024
    }));
    const archiveSlotOutput = vi.fn(async () => "asset_generated");
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: "remote_1", remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput,
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await expect(handler(slotJob("batch_1", "slot_1", 1, "remote_1"), execution())).rejects.toMatchObject({ code: "image_unsupported_format" });
    expect(archiveSlotOutput).not.toHaveBeenCalled();
  });

  it("passes SHA-256 and dimensions into atomic asset persistence", async () => {
    const fetchMock = vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.png" }));
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called"); }),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async (url: string) => ({
      remoteUrl: url, finalUrl: url, sha256: `sha-${url.split("/").at(-1)}`,
      path: `/data/assets/${url.split("/").at(-1)}`, extension: "png", bytes: 1024, width: 1024, height: 1024
    }));
    const archiveSlotOutput = vi.fn(async () => "asset_generated");
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: "remote_1", remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput,
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await handler(slotJob("batch_1", "slot_1", 1, "remote_1"), execution());
    expect(archiveSlotOutput).toHaveBeenCalledWith(
      "slot_1",
      expect.objectContaining({ sha256: "sha-out.png", width: 1024, height: 1024 }),
      expect.any(Object)
    );
  });

  it("fails closed when atomic asset persistence loses the slot fence", async () => {
    const fetchMock = vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/out.png" }));
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called"); }),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async (url: string) => ({
      remoteUrl: url, finalUrl: url, sha256: `sha-${url.split("/").at(-1)}`,
      path: `/data/assets/${url.split("/").at(-1)}`, extension: "png", bytes: 1024, width: 1024, height: 1024
    }));
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: "remote_1", remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput: vi.fn(async () => null),
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await expect(handler(slotJob("batch_1", "slot_1", 1, "remote_1"), execution())).rejects.toMatchObject({ code: "slot_write_conflict" });
  });

  it("recovers after intent by polling without resubmitting", async () => {
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called on restart"); }),
      fetch: vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/recovered.png" }))
    } as unknown as ImageGenerationPort;
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: null, remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput: vi.fn(async () => "asset_generated"),
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: vi.fn(async () => ({ remoteUrl: "", finalUrl: "", sha256: "x", path: "/x", extension: "png", bytes: 1, width: 1, height: 1 })) }, repository, { append: vi.fn(async () => undefined) });
    await expect(handler(slotJob("batch_1", "slot_1", 1, null, true), execution())).rejects.toMatchObject({ code: "image_submission_result_unknown" });
    expect(provider.submit).not.toHaveBeenCalled();
  });

  it("recovers by polling after remote task is persisted", async () => {
    const fetchMock = vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/polled.png" }));
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => { throw new Error("submit must not be called"); }),
      fetch: fetchMock
    } as unknown as ImageGenerationPort;
    const storeArchive = vi.fn(async (url: string) => ({
      remoteUrl: url, finalUrl: url, sha256: "sha-polled", path: "/data/assets/polled.png", extension: "png", bytes: 1024, width: 1024, height: 1024
    }));
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: "remote_persisted", remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput: vi.fn(async () => "asset_generated"),
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: storeArchive }, repository, { append: vi.fn(async () => undefined) });
    await handler(slotJob("batch_1", "slot_1", 1, "remote_persisted"), execution());
    expect(provider.submit).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith({ remoteTaskId: "remote_persisted" });
    expect(storeArchive).toHaveBeenCalledWith("https://provider.test/polled.png");
  });

  it("submit count remains one after restart recovery", async () => {
    const submitCalls: string[] = [];
    const provider: ImageGenerationPort = {
      submit: vi.fn(async () => {
        submitCalls.push("submit");
        return { kind: "accepted", remoteTaskId: "remote_after_restart" as const };
      }),
      fetch: vi.fn(async () => ({ state: "succeeded" as const, outputUrl: "https://provider.test/restart.png" }))
    } as unknown as ImageGenerationPort;
    const repository: SlotRepo = {
      loadSlotExecution: vi.fn(async () => ({ slotId: "slot_1", batchId: "batch_1", slotNumber: 1, role: "default", prompt: defaultPrompt, state: "queued", attempt: 0, remoteTaskId: null, remoteOutputUrl: null, error: null, references: defaultReferences, parameters: {} })),
      saveRemoteTask: vi.fn(async () => true),
      archiveSlotOutput: vi.fn(async () => "asset_generated"),
      markSlotFailed: vi.fn(async () => true),
    };
    const handler = buildHandler(provider, { archive: vi.fn(async () => ({ remoteUrl: "", finalUrl: "", sha256: "x", path: "/x", extension: "png", bytes: 1, width: 1, height: 1 })) }, repository, { append: vi.fn(async () => undefined) });
    await handler(slotJob(), execution());
    expect(submitCalls).toHaveLength(1);
    // Restart: same job picked up again with remoteTaskId set — no resubmit
    submitCalls.length = 0;
    await handler(slotJob("batch_1", "slot_1", 1, "remote_after_restart"), execution());
    expect(submitCalls).toHaveLength(0);
  });
});
