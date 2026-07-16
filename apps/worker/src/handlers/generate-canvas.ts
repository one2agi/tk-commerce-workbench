import type { AssetStagingPort, CanvasPort, IdempotencyKey } from "@tk/contracts";
import { selectCanvasInputs, type CanvasCandidate } from "@tk/domain/assets/select-canvas-inputs";
import { ExternalResultUnknownError, NeedsInputError, requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

export interface CanvasPlan {
  workflowId: string;
  templateVersion: number;
  productImages: CanvasCandidate[];
  referenceAssetIds: string[];
  localAssetIds: string[];
  sourceLocale: string;
  targetLocale: string;
  style: string;
  promptFragment: string;
  expectedOutputCount: number;
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
  maxRunsPerDay: number;
}): WorkerHandler {
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
    if (job.remoteTaskId) {
      const plan = await input.repository.loadPlan(revisionId);
      await input.audit.append({ action: "canvas.fetch.call", targetKind: "product_revision", targetId: revisionId, payload: { remoteTaskId: job.remoteTaskId }, redacted: true });
      execution.assertLease();
      let fetched;
      try {
        fetched = await input.canvas.fetchOutputs({ remoteTaskId: job.remoteTaskId });
      } catch {
        try {
          await input.audit.append({ action: "canvas.fetch.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "result_unknown" }, redacted: true });
        } catch {
          // Preserve the reconciliation outcome even if audit persistence is unavailable.
        }
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

    const plan = await input.repository.loadPlan(revisionId);
    await input.audit.append({ action: "canvas.capacity.call", targetKind: "product_revision", targetId: revisionId, payload: { workflowId: plan.workflowId }, redacted: true });
    execution.assertLease();
    let capacity;
    try {
      capacity = await input.canvas.readWorkflowCapacity(plan.workflowId);
    } catch (error) {
      try {
        await input.audit.append({ action: "canvas.capacity.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "failed", code: "external_request_failed" }, redacted: true });
      } catch {
        // Preserve the external failure when audit persistence is also unavailable.
      }
      throw error;
    }
    await input.audit.append({ action: "canvas.capacity.result", targetKind: "product_revision", targetId: revisionId, payload: { workflowVersion: capacity.workflowVersion, inputCapacity: capacity.inputCapacity }, redacted: true });
    const referenceIds = [...new Set(plan.referenceAssetIds)];
    const referenceSet = new Set(referenceIds);
    const productImages = plan.productImages.filter((asset) => !referenceSet.has(asset.assetId));
    const selected = selectCanvasInputs({ candidates: productImages, referenceUrls: referenceIds, capacity: capacity.inputCapacity });
    const day = input.now().toISOString().slice(0, 10);
    const reserved = await input.quota.reserve({ runKey: job.businessKey ?? job.jobId, day, limit: input.maxRunsPerDay });
    if (!reserved) {
      await input.audit.append({ action: "canvas.quota.denied", targetKind: "product_revision", targetId: revisionId, payload: { day, limit: input.maxRunsPerDay }, redacted: true });
      throw new NeedsInputError("canvas_daily_limit", "Canvas daily run limit reached");
    }

    const selectedIds = selected.productImages.map((asset) => asset.assetId);
    const allStagedIds = [...selectedIds, ...referenceIds];
    let staged: Awaited<ReturnType<AssetStagingPort["stage"]>> = [];
    let submitted: Awaited<ReturnType<CanvasPort["submit"]>> | null = null;
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
        payload: { version: 1, revisionId, remoteUrls: staged.map((asset) => asset.remoteUrl) },
        delayMs: 3_600_000
      });
      execution.assertLease();
      await input.audit.append({ action: "canvas.submit.call", targetKind: "product_revision", targetId: revisionId, payload: { workflowId: capacity.workflowId, workflowVersion: capacity.workflowVersion, imageCount: staged.length }, redacted: true });
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
          idempotencyKey: `canvas:${revisionId}:${plan.templateVersion}` as IdempotencyKey
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
        await input.audit.append({ action: "canvas.fetch.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "result_unknown" }, redacted: true });
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
      if (submitted) throw new ExternalResultUnknownError(submitted.remoteTaskId, "Canvas result is unknown after submit");
      throw error;
    } finally {
      if (staged.length > 0) {
        try {
          await input.audit.append({ action: "staging.release.call", targetKind: "product_revision", targetId: revisionId, payload: { stagedCount: staged.length }, redacted: true });
        } catch {
          // Cleanup remains mandatory even if audit persistence is unavailable.
        }
        try {
          await input.staging.release({ remoteUrls: staged.map((asset) => asset.remoteUrl) });
          await input.audit.append({ action: "staging.release.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "succeeded" }, redacted: true });
        } catch {
          try {
            await input.audit.append({ action: "staging.release.result", targetKind: "product_revision", targetId: revisionId, payload: { state: "failed", code: "cleanup_deferred" }, redacted: true });
          } catch {
            // The persisted cleanup job remains the recovery path.
          }
        }
      }
    }
  };
}
