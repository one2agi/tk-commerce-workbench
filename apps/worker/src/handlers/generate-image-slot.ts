import { idempotencyKey, parseImageGenerateSlotJobPayload, type ImageGenerationPort, type PlannedImagePromptV1, type ResolvedImageReferenceV1 } from "@tk/contracts";
import { NeedsInputError, RetryableJobError, type WorkerHandler } from "../runtime/worker-loop.js";

export interface SlotRepository {
  loadSlotExecution(
    slotId: string,
    fence: SlotFence
  ): Promise<{
    slotId: string;
    batchId: string;
    slotNumber: number;
    role: string;
    prompt: PlannedImagePromptV1 | null;
    state: string;
    attempt: number;
    remoteTaskId: string | null;
    remoteOutputUrl: string | null;
    error: unknown;
    references: readonly ResolvedImageReferenceV1[];
    parameters: Readonly<Record<string, unknown>>;
  } | null>;

  saveRemoteTask(slotId: string, fence: SlotFence, remoteTaskId: string): Promise<boolean>;
  saveRemoteOutput(slotId: string, fence: SlotFence, remoteOutputUrl: string): Promise<boolean>;
  markSlotFailed(slotId: string, error: unknown, fence: SlotFence): Promise<boolean>;
  archiveSlotOutput(
    slotId: string,
    archived: Awaited<ReturnType<ContentAddressedStore["archive"]>>,
    fence: SlotFence
  ): Promise<string | null>;
}

export interface SlotFence {
  jobId: string;
  owner: string;
  leaseToken: string;
}

export interface ContentAddressedStore {
  archive(remoteUrl: string): Promise<{
    readonly remoteUrl: string;
    readonly finalUrl: string;
    readonly sha256: string;
    readonly path: string;
    readonly extension: string;
    readonly bytes: number;
    readonly width: number;
    readonly height: number;
  }>;
}

export interface GenerateImageSlotDeps {
  provider: ImageGenerationPort;
  store: ContentAddressedStore;
  repository: SlotRepository;
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}

const SUPPORTED_EXTENSIONS = new Set(["png", "jpeg", "jpg"]);

function assertImageValid(archived: { width: number; height: number; extension: string; bytes: number }): void {
  if (archived.width <= 0 || archived.height <= 0) {
    throw new NeedsInputError("image_invalid_dimensions", "Archived image has invalid dimensions");
  }
  if (!SUPPORTED_EXTENSIONS.has(archived.extension.toLowerCase())) {
    throw new NeedsInputError("image_unsupported_format", "Only PNG and JPEG formats are supported");
  }
}

async function archiveAndPersist(input: GenerateImageSlotDeps, options: {
  slotId: string;
  outputUrl: string;
  fence: SlotFence;
  execution: { assertLease(): void };
}): Promise<void> {
  options.execution.assertLease();
  const archived = await input.store.archive(options.outputUrl);
  assertImageValid(archived);
  options.execution.assertLease();
  const archivedAssetId = await input.repository.archiveSlotOutput(
    options.slotId,
    archived,
    options.fence
  );
  if (!archivedAssetId) {
    throw new NeedsInputError("slot_write_conflict", "Slot state changed during archive persistence; retry");
  }
  await input.audit.append({
    action: "image_slot.succeeded",
    targetKind: "image_generation_slot",
    targetId: options.slotId,
    payload: { archivedAssetId, width: archived.width, height: archived.height },
    redacted: true
  });
}

export function createGenerateImageSlotHandler(input: GenerateImageSlotDeps): WorkerHandler {
  return async (job, execution) => {
    const { batchId, slotId, slotNumber } = parseImageGenerateSlotJobPayload(job.payload);

    const fence: SlotFence = {
      jobId: job.jobId,
      owner: execution.fence.owner,
      leaseToken: execution.fence.leaseToken
    };

    const slot = await input.repository.loadSlotExecution(slotId, fence);
    if (!slot) {
      throw new NeedsInputError("slot_not_found", "Slot execution context not found");
    }

    if (slot.prompt === null) {
      throw new NeedsInputError("slot_prompt_not_ready", "Slot prompt is not ready");
    }

    if (slot.remoteOutputUrl) {
      await archiveAndPersist(input, { slotId, outputUrl: slot.remoteOutputUrl, fence, execution });
      return { next: [] };
    }

    // If a remote task is already persisted, recover by polling
    if (job.remoteTaskId) {
      await input.audit.append({
        action: "image_slot.fetch.call",
        targetKind: "image_generation_slot",
        targetId: slotId,
        payload: { remoteTaskId: job.remoteTaskId },
        redacted: true
      });
      execution.assertLease();
      const result = await input.provider.fetch({ remoteTaskId: job.remoteTaskId });

      await input.audit.append({
        action: "image_slot.fetch.result",
        targetKind: "image_generation_slot",
        targetId: slotId,
        payload: { state: result.state },
        redacted: true
      });

      if (result.state === "pending") {
        throw new RetryableJobError("image_pending", "Image generation is still pending", 30_000);
      }

      if (result.state === "failed") {
        await input.repository.markSlotFailed(slotId, result.failure, fence);
        throw result.failure;
      }

      execution.assertLease();
      if (!await input.repository.saveRemoteOutput(slotId, fence, result.outputUrl)) {
        throw new NeedsInputError("slot_write_conflict", "Slot state changed before output checkpoint; retry");
      }
      await archiveAndPersist(input, { slotId, outputUrl: result.outputUrl, fence, execution });

      return { next: [] };
    }

    // Check for reconciliation intent without remote task — fail closed, no resubmit
    const payload = job.payload as Record<string, unknown>;
    if (payload.reconciliationIntent !== undefined) {
      throw new NeedsInputError(
        "image_submission_result_unknown",
        "Image submit intent exists but no remote task id; reconcile manually and do not submit again"
      );
    }

    // No remote task yet — submit a new image generation request
    const slotIdempotencyKey = idempotencyKey(`slot:${batchId}:${slotNumber}:${slotId}`);

    await input.audit.append({
      action: "image_slot.submit.call",
      targetKind: "image_generation_slot",
      targetId: slotId,
      payload: { slot: slotNumber, role: slot.role },
      redacted: true
    });

    execution.assertLease();
    await execution.persistReconciliationIntent({
      version: 1,
      operation: "image_generate_slot",
      idempotencyKey: slotIdempotencyKey
    });

    let submitResult: Awaited<ReturnType<ImageGenerationPort["submit"]>>;
    try {
      execution.assertLease();
      submitResult = await input.provider.submit({
        prompt: slot.prompt,
        references: slot.references,
        parameters: slot.parameters,
        idempotencyKey: slotIdempotencyKey
      });
    } catch {
      try {
        await input.audit.append({
          action: "image_slot.submit.result",
          targetKind: "image_generation_slot",
          targetId: slotId,
          payload: { state: "result_unknown" },
          redacted: true
        });
      } catch {
        // Preserve the failure even when audit persistence is unavailable.
      }
      throw new NeedsInputError(
        "image_submission_result_unknown",
        "Image submission result is unknown after submit attempt"
      );
    }

    await input.audit.append({
      action: "image_slot.submit.result",
      targetKind: "image_generation_slot",
      targetId: slotId,
      payload: {
        state: submitResult.kind === "completed" ? "completed" : "accepted",
        remoteTaskId: submitResult.kind === "accepted" ? submitResult.remoteTaskId : undefined
      },
      redacted: true
    });

    if (submitResult.kind === "completed") {
      // Synchronous completion with URL — go straight to archival
      execution.assertLease();
      if (!await input.repository.saveRemoteOutput(slotId, fence, submitResult.outputUrl)) {
        throw new NeedsInputError("slot_write_conflict", "Slot state changed before output checkpoint; retry");
      }
      await archiveAndPersist(input, { slotId, outputUrl: submitResult.outputUrl, fence, execution });

      return { next: [] };
    }

    // Async: remote task id returned — persist it then poll
    execution.assertLease();
    await execution.persistRemoteTask(submitResult.remoteTaskId);

    await input.audit.append({
      action: "image_slot.fetch.call",
      targetKind: "image_generation_slot",
      targetId: slotId,
      payload: { remoteTaskId: submitResult.remoteTaskId },
      redacted: true
    });

    execution.assertLease();
    const fetchResult = await input.provider.fetch({ remoteTaskId: submitResult.remoteTaskId });

    await input.audit.append({
      action: "image_slot.fetch.result",
      targetKind: "image_generation_slot",
      targetId: slotId,
      payload: { state: fetchResult.state },
      redacted: true
    });

    if (fetchResult.state === "pending") {
      throw new RetryableJobError("image_pending", "Image generation is still pending", 30_000);
    }

    if (fetchResult.state === "failed") {
      await input.repository.markSlotFailed(slotId, fetchResult.failure, fence);
      throw fetchResult.failure;
    }

    // Succeeded
    execution.assertLease();
    if (!await input.repository.saveRemoteOutput(slotId, fence, fetchResult.outputUrl)) {
      throw new NeedsInputError("slot_write_conflict", "Slot state changed before output checkpoint; retry");
    }
    await archiveAndPersist(input, { slotId, outputUrl: fetchResult.outputUrl, fence, execution });

    return { next: [] };
  };
}
