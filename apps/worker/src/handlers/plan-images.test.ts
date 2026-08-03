import { describe, expect, it, vi } from "vitest";
import type { FrozenImageGenerationRecipeV1, ImagePromptPlannerPort, PlannedImagePromptV1 } from "@tk/contracts";
import type { ClaimedWorkerJob, WorkerExecutionContext } from "../runtime/worker-loop.js";
import { createPlanImagesHandler, type PlanImagesDeps } from "./plan-images.js";

const job = (batchId: string): ClaimedWorkerJob => ({
  jobId: `job-${batchId}`,
  kind: "image_prompt_plan",
  businessKey: `plan:${batchId}`,
  payload: { version: 1, batchId },
  leaseToken: "lease-1",
  remoteTaskId: null
});

const execution: WorkerExecutionContext = {
  fence: { jobId: "job-test", owner: "worker-test", leaseToken: "lease-1" },
  signal: new AbortController().signal,
  assertLease: vi.fn(),
  persistReconciliationIntent: vi.fn(async () => undefined),
  persistRemoteTask: vi.fn(async () => undefined),
  scheduleCompensation: vi.fn(async () => undefined)
};

function validPlan(requestedOutputCount: number): { prompts: PlannedImagePromptV1[] } {
  const prompts: PlannedImagePromptV1[] = Array.from({ length: requestedOutputCount }, (_, i) => ({
    slot: i + 1,
    role: "default",
    prompt: `Generated prompt ${i + 1}`,
    mustPreserve: [],
    forbidden: []
  }));
  return { prompts };
}

function recipe(outputCount: number): FrozenImageGenerationRecipeV1 {
  return {
    version: 1,
    inputCount: 3,
    outputCount,
    mustPreserve: ["product identity"],
    visualDirection: "clean marketplace photography",
    forbidden: ["brand logos"],
    roles: [{ key: "default", instruction: "show the product clearly" }],
    providerParameters: {}
  };
}

const references = [
  { assetId: "asset_2", localPath: "/assets/second.png", extension: "png" as const },
  { assetId: "asset_1", localPath: "/assets/first.jpg", extension: "jpg" as const }
];

const savePlanMock = () => vi.fn(async (
  _batchId: string,
  _input: { prompts: PlannedImagePromptV1[] },
  _fence: WorkerExecutionContext["fence"]
) => undefined);

function deps(overrides: {
  planner?: ImagePromptPlannerPort;
  repository?: PlanImagesDeps["repository"];
  audit?: PlanImagesDeps["audit"];
}): PlanImagesDeps {
  const planner = overrides.planner ?? {
    plan: vi.fn(async () => ({ prompts: validPlan(1).prompts }))
  };
  const repository = overrides.repository ?? {
    loadPlanningContext: vi.fn(async () => ({
      batchId: "batch_1",
      productId: "product_1",
      revisionId: "rev_1",
      templateId: "tmpl_1",
      templateVersionId: "tmpl_v_1",
      recipe: recipe(3),
      references,
      productFacts: {}
    })),
    savePlanAndQueueSlots: savePlanMock()
  };
  const audit = overrides.audit ?? { append: vi.fn(async () => undefined) };
  return { planner, repository, audit };
}

describe("plan-images handler", () => {
  it("persists exactly M prompts and releases exactly M slot jobs", async () => {
    const repository = {
      loadPlanningContext: vi.fn(async () => ({
        batchId: "batch_1",
        productId: "product_1",
        revisionId: "rev_1",
        templateId: "tmpl_1",
        templateVersionId: "tmpl_v_1",
        recipe: recipe(5),
        references,
        productFacts: {}
      })),
      savePlanAndQueueSlots: savePlanMock()
    };
    const planner = { plan: vi.fn(async () => ({ prompts: validPlan(5).prompts })) };
    const handler = createPlanImagesHandler(deps({ planner, repository }));
    const result = await handler(job("batch_1"), execution);
    // Verify savePlanAndQueueSlots was called with correct args via mock.calls
    const calls = repository.savePlanAndQueueSlots.mock.calls;
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("batch_1");
    expect(calls[0]?.[1]).toMatchObject({ prompts: expect.any(Array) });
    expect((calls[0]?.[1] as { prompts: unknown[] } | undefined)?.prompts).toHaveLength(5);
    expect(calls[0]?.[2]).toEqual(execution.fence);
    expect(result.next).toHaveLength(0); // repository transaction owns slot enqueueing
  });

  it("does not enqueue slots when prompt count mismatches", async () => {
    const repository = {
      loadPlanningContext: vi.fn(async () => ({
        batchId: "batch_5",
        productId: "product_5",
        revisionId: "rev_5",
        templateId: "tmpl_1",
        templateVersionId: "tmpl_v_1",
        recipe: recipe(5),
        references,
        productFacts: {}
      })),
      savePlanAndQueueSlots: savePlanMock()
    };
    const planner = { plan: vi.fn(async () => ({ prompts: validPlan(4).prompts })) };
    const handler = createPlanImagesHandler(deps({ planner, repository }));
    await expect(handler(job("batch_5"), execution)).rejects.toMatchObject({ code: "image_plan_slots_invalid" });
    expect(repository.savePlanAndQueueSlots).not.toHaveBeenCalled();
  });

  it("loads frozen planning context by batchId", async () => {
    const repository = {
      loadPlanningContext: vi.fn(async () => ({
        batchId: "batch_ctx",
        productId: "product_ctx",
        revisionId: "rev_ctx",
        templateId: "tmpl_ctx",
        templateVersionId: "tmpl_v_ctx",
        recipe: recipe(3),
        references,
        productFacts: { title: "Test Product" }
      })),
      savePlanAndQueueSlots: savePlanMock()
    };
    const planner = { plan: vi.fn(async () => ({ prompts: validPlan(3).prompts })) };
    const handler = createPlanImagesHandler(deps({ planner, repository }));
    await handler(job("batch_ctx"), execution);
    expect(repository.loadPlanningContext).toHaveBeenCalledWith("batch_ctx");
  });

  it("calls planner with correct idempotency key using plan:${batchId}", async () => {
    const repository = {
      loadPlanningContext: vi.fn(async () => ({
        batchId: "batch_idem",
        productId: "product_idem",
        revisionId: "rev_idem",
        templateId: "tmpl_idem",
        templateVersionId: "tmpl_v_idem",
        recipe: recipe(3),
        references,
        productFacts: {}
      })),
      savePlanAndQueueSlots: savePlanMock()
    };
    const planSpy = vi.fn(async () => ({ prompts: validPlan(3).prompts }));
    const planner = { plan: planSpy };
    const handler = createPlanImagesHandler(deps({ planner, repository }));
    await handler(job("batch_idem"), execution);
    expect(planSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        idempotencyKey: "plan:batch_idem",
        references: [
          { assetId: "asset_2", localPath: "/assets/second.png", extension: "png" },
          { assetId: "asset_1", localPath: "/assets/first.jpg", extension: "jpg" }
        ]
      })
    );
  });

  it("throws retryable error when planner fails transiently", async () => {
    const repository = {
      loadPlanningContext: vi.fn(async () => ({
        batchId: "batch_retry",
        productId: "product_retry",
        revisionId: "rev_retry",
        templateId: "tmpl_retry",
        templateVersionId: "tmpl_v_retry",
        recipe: recipe(3),
        references,
        productFacts: {}
      })),
      savePlanAndQueueSlots: savePlanMock()
    };
    const planner = { plan: vi.fn(async () => { throw new Error("transient failure"); }) };
    const handler = createPlanImagesHandler(deps({ planner, repository }));
    await expect(handler(job("batch_retry"), execution)).rejects.toThrow("Image prompt planner was temporarily unavailable");
  });

  it("returns empty next jobs after successful plan persistence", async () => {
    const repository = {
      loadPlanningContext: vi.fn(async () => ({
        batchId: "batch_empty",
        productId: "product_empty",
        revisionId: "rev_empty",
        templateId: "tmpl_empty",
        templateVersionId: "tmpl_v_empty",
        recipe: recipe(3),
        references,
        productFacts: {}
      })),
      savePlanAndQueueSlots: savePlanMock()
    };
    const planner = { plan: vi.fn(async () => ({ prompts: validPlan(3).prompts })) };
    const handler = createPlanImagesHandler(deps({ planner, repository }));
    const result = await handler(job("batch_empty"), execution);
    expect(result.next).toEqual([]);
  });
});
