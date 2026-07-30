import type { AssetStagingPort, CanvasPort, IdempotencyKey } from "@tk/contracts";
import { isExternalFailure } from "@tk/contracts/errors";
import { selectCanvasInputs, type CanvasCandidate } from "@tk/domain/assets/select-canvas-inputs";
import { ExternalResultUnknownError, NeedsInputError, RetryableJobError, requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";
import type { StagingCleanupCodec } from "../runtime/staging-cleanup-codec.js";

const LIVE_IMAGE_MODEL_INPUT_LIMIT = 6;

export interface CanvasPlan {
  workflowId: string;
  templateVersion: number;
  productImages: CanvasCandidate[];
  referenceAssetIds: string[];
  referenceImageUrls?: string[];
  localAssetIds: string[];
  sourceLocale: string;
  targetLocale: string;
  style: string;
  promptFragment: string;
  expectedOutputCount: number;
  canvasInputCapacity?: number;
}

export function createCanvasHandler(input: {
  canvas: CanvasPort;
  staging: AssetStagingPort;
  store: { archive(remoteUrl: string): Promise<Record<string, unknown>> };
  repository: {
    loadPlan(revisionId: string): Promise<CanvasPlan>;
    saveOutputs(value: Record<string, unknown>, fence: LeaseFence): Promise<boolean>;
  };
  quota: { reserve(value: { runKey: string; day: string; limit: number }): Promise<boolean> };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
  now: () => Date;
  cleanupCodec: StagingCleanupCodec;
  maxRunsPerDay: number;
}): WorkerHandler {
  const isRetryableCanvasNotReady = (error: unknown) =>
    Boolean(error && typeof error === "object" &&
      (error as { kind?: unknown }).kind === "retryable" &&
      (error as { code?: unknown }).code === "canvas.not_ready");
  const loadPlan = async (revisionId: string) => {
    try {
      return await input.repository.loadPlan(revisionId);
    } catch (error) {
      if (typeof error === "object" && error !== null &&
          (error as { code?: unknown }).code === "template_reference_unavailable") {
        throw new NeedsInputError(
          "template_reference_unavailable",
          "One or more template reference assets are not ready locally"
        );
      }
      throw error;
    }
  };
  const archiveOutputs = async (
    outputs: Array<{ url: string; width: number; height: number; sha256: string }>,
    execution: Parameters<WorkerHandler>[1]
  ) => {
    const settled = await Promise.allSettled(outputs.map(async (output) => {
      execution.assertLease();
      const archived = await input.store.archive(output.url);
      return {
        ...archived,
        remoteUrl: output.url,
        width: output.width,
        height: output.height,
        providerSha256: output.sha256
      };
    }));
    return {
      assets: settled.flatMap((result) => result.status === "fulfilled" ? [result.value] : []),
      failedCount: settled.filter((result) => result.status === "rejected").length
    };
  };

  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    if (!job.remoteTaskId && job.payload.reconciliationIntent !== undefined) {
      throw new NeedsInputError(
        "reconcile_required",
        "Canvas submit intent already exists without a remote task id; reconcile manually and do not submit again"
      );
    }
    if (job.remoteTaskId) {
      const plan = await loadPlan(revisionId);
      await input.audit.append({ action: "canvas.fetch.call", targetKind: "product_revision", targetId: revisionId, payload: { remoteTaskId: job.remoteTaskId }, redacted: true });
      execution.assertLease();
      let fetched;
      try {
        fetched = await input.canvas.fetchOutputs({ remoteTaskId: job.remoteTaskId });
      } catch (error) {
        try {
          await input.audit.append({
            action: "canvas.fetch.result",
            targetKind: "product_revision",
            targetId: revisionId,
            payload: isExternalFailure(error)
              ? { state: "failed", code: error.code }
              : { state: "result_unknown" },
            redacted: true
          });
        } catch {
          // Preserve the reconciliation outcome even if audit persistence is unavailable.
        }
        if (isRetryableCanvasNotReady(error)) {
          throw new RetryableJobError("canvas.not_ready", "Canvas output is not ready yet", 30_000);
        }
        if (isExternalFailure(error)) throw error;
        throw new ExternalResultUnknownError(job.remoteTaskId, "Canvas result is unknown after fetch");
      }
      const archived = await archiveOutputs(fetched.outputs, execution);
      const state = archived.assets.length === 0
        ? "failed"
        : archived.failedCount > 0 || archived.assets.length < plan.expectedOutputCount ? "partial" : "succeeded";
      execution.assertLease();
      requireFencedWrite(await input.repository.saveOutputs({ revisionId, remoteTaskId: job.remoteTaskId, assets: archived.assets, state }, execution.fence));
      await input.audit.append({ action: "canvas.fetch.result", targetKind: "product_revision", targetId: revisionId, payload: { receivedCount: fetched.outputs.length, outputCount: archived.assets.length, state }, redacted: true });
      if (archived.assets.length === 0) throw new NeedsInputError("canvas_zero_valid_outputs", "Canvas returned no locally valid outputs");
      return { next: [{ kind: "final_preview", businessKey: `${revisionId}:preview`, payload: { version: 1, revisionId } }] };
    }

    const plan = await loadPlan(revisionId);
    await input.audit.append({ action: "canvas.capacity.call", targetKind: "product_revision", targetId: revisionId, payload: { workflowId: plan.workflowId }, redacted: true });
    execution.assertLease();
    let capacity;
    try {
      capacity = await input.canvas.readWorkflowCapacity(plan.workflowId);
    } catch (error) {
      try {
        await input.audit.append({
          action: "canvas.capacity.result",
          targetKind: "product_revision",
          targetId: revisionId,
          payload: {
            state: "failed",
            code: isExternalFailure(error) ? error.code : "external_request_failed"
          },
          redacted: true
        });
      } catch {
        // Preserve the external failure when audit persistence is also unavailable.
      }
      throw error;
    }
    await input.audit.append({ action: "canvas.capacity.result", targetKind: "product_revision", targetId: revisionId, payload: { workflowVersion: capacity.workflowVersion, inputCapacity: capacity.inputCapacity }, redacted: true });
    const referenceIds = [...new Set(plan.referenceAssetIds)];
    const referenceSet = new Set(referenceIds);
    const productImages = plan.productImages.filter((asset) => !referenceSet.has(asset.assetId));
    const requestedCapacity = Number.isInteger(plan.canvasInputCapacity) && Number(plan.canvasInputCapacity) > 0
      ? Math.min(Number(plan.canvasInputCapacity), capacity.inputCapacity)
      : capacity.inputCapacity;
    const effectiveCapacity = Math.min(requestedCapacity, LIVE_IMAGE_MODEL_INPUT_LIMIT);
    const selected = selectCanvasInputs({ candidates: productImages, referenceUrls: plan.referenceImageUrls ?? referenceIds, capacity: effectiveCapacity });
    const day = input.now().toISOString().slice(0, 10);
    const reserved = await input.quota.reserve({ runKey: job.businessKey ?? job.jobId, day, limit: input.maxRunsPerDay });
    if (!reserved) {
      await input.audit.append({ action: "canvas.quota.denied", targetKind: "product_revision", targetId: revisionId, payload: { day, limit: input.maxRunsPerDay }, redacted: true });
      throw new NeedsInputError("canvas_daily_limit", "Canvas daily run limit reached");
    }

    const selectedIds = selected.productImages.map((asset) => asset.assetId);
    const selectedLocalAssetIds = selected.productImages.map((asset) => asset.url);
    const selectedReferenceLocalAssetIds = selected.referenceUrls;
    const allStagedIds = [...selectedLocalAssetIds, ...selectedReferenceLocalAssetIds];
    let staged: Awaited<ReturnType<AssetStagingPort["stage"]>> = [];
    let submitted: Awaited<ReturnType<CanvasPort["submit"]>> | null = null;
    let releaseStagedInFinally = true;
    try {
      execution.assertLease();
      await input.audit.append({ action: "staging.stage.call", targetKind: "product_revision", targetId: revisionId, payload: { assetCount: selectedIds.length, purpose: "canvas" }, redacted: true });
      try {
        staged = await input.staging.stage({ localAssetIds: allStagedIds, purpose: "canvas" });
        if (staged.length !== allStagedIds.length) {
          throw new NeedsInputError("canvas_staging_incomplete", "Canvas inputs could not all be staged");
        }
        await input.audit.append({ action: "staging.stage.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "succeeded", stagedCount: staged.length }, redacted: true });
      } catch (error) {
        await input.audit.append({ action: "staging.stage.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "failed", code: "staging_failed" }, redacted: true });
        throw error;
      }
      await execution.scheduleCompensation({
        kind: "staging_cleanup",
        businessKey: `${job.businessKey ?? job.jobId}:staging-cleanup`,
        payload: {
          version: 1,
          revisionId,
          protectedRemoteUrls: input.cleanupCodec.protect({
            remoteUrls: staged.map((asset) => asset.remoteUrl),
            expiresAt: staged.map((asset) => asset.expiresAt).sort()[0]!
          })
        },
        delayMs: 3_600_000
      });
      execution.assertLease();
      await input.audit.append({ action: "canvas.submit.call", targetKind: "product_revision", targetId: revisionId, payload: { workflowId: capacity.workflowId, workflowVersion: capacity.workflowVersion, imageCount: staged.length }, redacted: true });
      const canvasIdempotencyKey = `canvas:${revisionId}:${plan.templateVersion}` as IdempotencyKey;
      await execution.persistReconciliationIntent({
        version: 1,
        operation: "canvas_submit",
        idempotencyKey: canvasIdempotencyKey,
        revisionId,
        workflowId: capacity.workflowId,
        workflowVersion: capacity.workflowVersion,
        templateVersion: plan.templateVersion
      });
      try {
        submitted = await input.canvas.submit({
          workflowId: capacity.workflowId,
          workflowVersion: capacity.workflowVersion,
          imageUrls: staged.slice(0, selectedIds.length).map((asset) => asset.remoteUrl),
          referenceImageUrls: staged.slice(selectedIds.length).map((asset) => asset.remoteUrl),
          promptContext: {
            sourceLocale: plan.sourceLocale,
            targetLocale: plan.targetLocale,
            style: plan.promptFragment
              ? `${plan.style}\n--- template prompt ---\n${plan.promptFragment}`
              : plan.style
          },
          idempotencyKey: canvasIdempotencyKey
        });
      } catch {
        try {
          await input.audit.append({ action: "canvas.submit.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "result_unknown" }, redacted: true });
        } catch {
          // Fail closed even when recording the failure event also fails.
        }
        throw new NeedsInputError("reconcile_required", "Canvas submit result is unknown; do not retry automatically");
      }
      await execution.persistRemoteTask(submitted.remoteTaskId);
      await input.audit.append({ action: "canvas.submit.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "accepted", remoteTaskId: submitted.remoteTaskId, submittedAt: submitted.submittedAt }, redacted: true });
      await input.audit.append({ action: "canvas.fetch.call", targetKind: "product_revision", targetId: revisionId, payload: { remoteTaskId: submitted.remoteTaskId }, redacted: true });
      let fetched;
      try {
        fetched = await input.canvas.fetchOutputs({ remoteTaskId: submitted.remoteTaskId });
      } catch (error) {
        await input.audit.append({
          action: "canvas.fetch.result",
          targetKind: "product_revision",
          targetId: revisionId,
          payload: isExternalFailure(error)
            ? { state: "failed", code: error.code }
            : { state: "result_unknown" },
          redacted: true
        });
        if (isRetryableCanvasNotReady(error)) {
          releaseStagedInFinally = false;
          throw new RetryableJobError("canvas.not_ready", "Canvas output is not ready yet", 30_000);
        }
        if (isExternalFailure(error)) {
          if (error.kind === "retryable") releaseStagedInFinally = false;
          throw error;
        }
        throw error;
      }
      const expected = capacity.expectedOutputCount || plan.expectedOutputCount;
      const archived = await archiveOutputs(fetched.outputs, execution);
      const state = archived.assets.length === 0
        ? "failed"
        : archived.failedCount > 0 || archived.assets.length < expected ? "partial" : "succeeded";
      execution.assertLease();
      requireFencedWrite(await input.repository.saveOutputs({ revisionId, remoteTaskId: submitted.remoteTaskId, assets: archived.assets, state }, execution.fence));
      await input.audit.append({ action: "canvas.fetch.result", targetKind: "product_revision", targetId: revisionId, payload: { receivedCount: fetched.outputs.length, outputCount: archived.assets.length, state }, redacted: true });
      if (archived.assets.length === 0) throw new NeedsInputError("canvas_zero_valid_outputs", "Canvas returned no locally valid outputs");
      return { next: [{ kind: "final_preview", businessKey: `${revisionId}:preview`, payload: { version: 1, revisionId } }] };
    } catch (error) {
      if (error instanceof NeedsInputError) throw error;
      if (error instanceof RetryableJobError) throw error;
      if (isExternalFailure(error)) throw error;
      if (submitted) throw new ExternalResultUnknownError(submitted.remoteTaskId, "Canvas result is unknown after submit");
      throw error;
    } finally {
      if (releaseStagedInFinally && staged.length > 0) {
        try {
          await input.audit.append({ action: "staging.release_best_effort.call", targetKind: "product_revision", targetId: revisionId, payload: { stagedCount: staged.length, remoteDeleteVerified: false }, redacted: true });
        } catch {
          // Cleanup remains mandatory even if audit persistence is unavailable.
        }
        try {
          await input.staging.release({ remoteUrls: staged.map((asset) => asset.remoteUrl) });
          await input.audit.append({ action: "staging.release_best_effort.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "local_tracking_cleared", remoteDeleteVerified: false }, redacted: true });
        } catch {
          try {
            await input.audit.append({ action: "staging.release_best_effort.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "failed", code: "ttl_expiry_pending" }, redacted: true });
          } catch {
            // The persisted cleanup job remains the recovery path.
          }
        }
      }
    }
  };
}
