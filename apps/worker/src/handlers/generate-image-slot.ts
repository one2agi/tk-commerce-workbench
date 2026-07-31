import { idempotencyKey, type ImageGenerationPort, type PlannedImagePromptV1 } from "@tk/contracts";
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
  } | null>;

  saveRemoteTask(slotId: string, fence: SlotFence, remoteTaskId: string): Promise<boolean>;
  markSlotSucceeded(slotId: string, archivedAssetId: string, fence: SlotFence): Promise<boolean>;
  markSlotFailed(slotId: string, error: unknown, fence: SlotFence): Promise<boolean>;
  saveSlotQualityMetadata(
    slotId: string,
    metadata: { sha256: string; perceptualHash?: string; duplicateWarning?: boolean },
    fence: SlotFence
  ): Promise<void>;
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

export function createGenerateImageSlotHandler(input: GenerateImageSlotDeps): WorkerHandler {
  return async (job, execution) => {
    const { batchId, slotId, slotNumber } = job.payload as {
      batchId: string;
      slotId: string;
      slotNumber: number;
      version: number;
    };

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

      // Succeeded — archive the output
      const outputUrl = result.outputUrl;
      execution.assertLease();
      const archived = await input.store.archive(outputUrl);
      assertImageValid(archived);

      // Save quality metadata (SHA-256, perceptual hash, duplicate warnings)
      try {
        await input.repository.saveSlotQualityMetadata(
          slotId,
          { sha256: archived.sha256 },
          fence
        );
      } catch (err) {
        // Duplicate SHA-256 detected across sibling slots
        const msg = err instanceof Error ? err.message : String(err);
        if (/duplicate|sha.?256/i.test(msg)) {
          await input.repository.markSlotFailed(slotId, { code: "image_output_duplicate", message: msg }, fence);
          throw new NeedsInputError("image_output_duplicate", "Duplicate image output detected");
        }
        throw err;
      }

      execution.assertLease();
      const succeeded = await input.repository.markSlotSucceeded(slotId, archived.path, fence);
      if (!succeeded) {
        throw new NeedsInputError("slot_write_conflict", "Slot state changed during write; retry");
      }

      await input.audit.append({
        action: "image_slot.succeeded",
        targetKind: "image_generation_slot",
        targetId: slotId,
        payload: { archivedAssetId: archived.path, width: archived.width, height: archived.height },
        redacted: true
      });

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
        referenceImagePaths: [], // slots receive fully-resolved prompts; staging is handled upstream
        parameters: {},
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
      const outputUrl = submitResult.outputUrl;
      execution.assertLease();
      const archived = await input.store.archive(outputUrl);
      assertImageValid(archived);

      await input.repository.saveSlotQualityMetadata(
        slotId,
        { sha256: archived.sha256 },
        fence
      );

      execution.assertLease();
      const succeeded = await input.repository.markSlotSucceeded(slotId, archived.path, fence);
      if (!succeeded) {
        throw new NeedsInputError("slot_write_conflict", "Slot state changed during write; retry");
      }

      await input.audit.append({
        action: "image_slot.succeeded",
        targetKind: "image_generation_slot",
        targetId: slotId,
        payload: { archivedAssetId: archived.path },
        redacted: true
      });

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
    const outputUrl = fetchResult.outputUrl;
    execution.assertLease();
    const archived = await input.store.archive(outputUrl);
    assertImageValid(archived);

    await input.repository.saveSlotQualityMetadata(
      slotId,
      { sha256: archived.sha256 },
      fence
    );

    execution.assertLease();
    const succeeded = await input.repository.markSlotSucceeded(slotId, archived.path, fence);
    if (!succeeded) {
      throw new NeedsInputError("slot_write_conflict", "Slot state changed during write; retry");
    }

    await input.audit.append({
      action: "image_slot.succeeded",
      targetKind: "image_generation_slot",
      targetId: slotId,
      payload: { archivedAssetId: archived.path, width: archived.width, height: archived.height },
      redacted: true
    });

    return { next: [] };
  };
}
