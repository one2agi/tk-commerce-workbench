import {
  idempotencyKey,
  type FrozenImageGenerationRecipeV1,
  type ImagePromptPlannerPort,
  type ResolvedImageReferenceV1
} from "@tk/contracts";
import { RetryableJobError, NeedsInputError, type WorkerHandler } from "../runtime/worker-loop.js";

export interface PlanImagesDeps {
  planner: ImagePromptPlannerPort;
  repository: {
    loadPlanningContext(batchId: string): Promise<{
      batchId: string;
      productId: string;
      revisionId: string;
      templateId: string;
      templateVersionId: string;
      recipe: FrozenImageGenerationRecipeV1;
      references: ResolvedImageReferenceV1[];
      productFacts: Record<string, unknown>;
    } | null>;
    savePlanAndQueueSlots(
      batchId: string,
      input: { prompts: Array<{ slot: number; role: string; prompt: string; mustPreserve: string[]; forbidden: string[] }> },
      fence: { jobId: string; owner: string; leaseToken: string }
    ): Promise<void>;
  };
  audit: { append(value: Record<string, unknown>): Promise<unknown> };
}

/**
 * Creates the image prompt planning handler.
 *
 * Responsibilities:
 * - Load frozen planning context by batchId from the repository
 * - Call the planner with plan:${batchId} as idempotency key
 * - Validate exact output count match at the worker boundary
 * - Persist prompts and queue slots in one fenced transaction via repository
 * - Map retryable planner failures to RetryableJobError
 * - Map configuration/invalid-input failures to NeedsInputError with Chinese-safe messages
 */
export function createPlanImagesHandler(input: PlanImagesDeps): WorkerHandler {
  return async (job, execution) => {
    const { batchId } = job.payload as { batchId: string; version: number };

    // Load frozen planning context
    const context = await input.repository.loadPlanningContext(batchId);
    if (!context) {
      throw new NeedsInputError(
        "batch_not_found",
        "Planning context not found for this batch"
      );
    }

    // Call planner with idempotency key
    let plannerResult: { prompts: Array<{ slot: number; role: string; prompt: string; mustPreserve: string[]; forbidden: string[] }> };
    try {
      plannerResult = await input.planner.plan({
        productFacts: context.productFacts,
        references: context.references,
        recipe: context.recipe,
        requestedOutputCount: context.recipe.outputCount,
        idempotencyKey: idempotencyKey(`plan:${batchId}`)
      });
    } catch (error) {
      if (error instanceof RetryableJobError) throw error;
      // Transient planner failures are retryable
      throw new RetryableJobError(
        "planner_failed",
        "Image prompt planner was temporarily unavailable",
        30_000
      );
    }

    // Validate exact count match at worker boundary
    if (plannerResult.prompts.length !== context.recipe.outputCount) {
      throw new NeedsInputError(
        "image_plan_slots_invalid",
        "Generated prompt count does not match requested output count"
      );
    }

    // Audit the planner call
    await input.audit.append({
      action: "image_plan.call",
      targetKind: "image_generation_batch",
      targetId: batchId,
      payload: {
        plannerPromptsCount: plannerResult.prompts.length,
        requestedOutputCount: context.recipe.outputCount,
        idempotencyKey: `plan:${batchId}`
      },
      redacted: true
    });

    // Persist prompts and queue slots in one fenced transaction
    // The repository transaction owns slot enqueueing, so next is empty
    await input.repository.savePlanAndQueueSlots(
      batchId,
      { prompts: plannerResult.prompts },
      execution.fence
    );

    await input.audit.append({
      action: "image_plan.save_slots",
      targetKind: "image_generation_batch",
      targetId: batchId,
      payload: {
        slotCount: plannerResult.prompts.length
      },
      redacted: true
    });

    // Repository transaction owns slot enqueueing; handler returns empty next
    return { next: [] };
  };
}
