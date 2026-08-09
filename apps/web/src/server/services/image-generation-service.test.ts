import { describe, expect, it, vi } from "vitest";
import { ImageGenerationService, type ImageGenerationServiceContext } from "./image-generation-service";

function mockRepository() {
  return {
    loadStartContext: vi.fn<any>().mockResolvedValue({
      productFacts: {
        title: "蕾丝蝴蝶结大帽檐遮阳草帽",
        category: "women.hat",
        attributes: [{ name: "颜色", value: "米白色" }]
      }
    }),
    createBatch: vi.fn<any>(),
    getProductProjection: vi.fn<any>(),
    retrySlot: vi.fn<any>(),
    excludeSlot: vi.fn<any>(),
    excludeSlotWeb: vi.fn<any>(),
    acceptPartial: vi.fn<any>()
  };
}

function mockTemplateStore() {
  return {
    resolveActiveByCategory: vi.fn<any>()
  };
}

function makeContext(repo = mockRepository(), store = mockTemplateStore()): ImageGenerationServiceContext {
  return {
    imageGenerationRepository: repo as any,
    imageGenerationTemplates: store as any
  };
}

const activeTemplateVersion = {
  id: "ver_active_1",
  templateId: "tmpl_1",
  version: 2,
  lifecycleState: "active" as const,
  recipe: {
    inputCounts: { default: 2, min: 1, max: 6 },
    outputCounts: { default: 4, min: 1, max: 8 },
    mustPreserve: [] as string[],
    visualDirection: "海边度假场景，商品为主体",
    forbidden: ["改变帽檐结构"],
    roles: [{ key: "hero", instruction: "Hero shot" }]
  },
  activatedAt: new Date(),
  createdAt: new Date()
};

const activeTemplate = {
  id: "tmpl_1",
  name: "Hat Template",
  categoryKey: "women.hat",
  parentCategoryKey: null,
  activeVersionId: "ver_active_1",
  enabled: true,
  archivedAt: null,
  createdAt: new Date(),
  updatedAt: new Date()
};

describe("ImageGenerationService", () => {
  describe("start", () => {
    it("starts with frozen ordered assets and an active resolved template", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      store.resolveActiveByCategory.mockResolvedValue({ template: activeTemplate, version: activeTemplateVersion });
      repo.createBatch.mockResolvedValue({ batchId: "batch_1", plannerJobId: "job_1" });

      const service = new ImageGenerationService(makeContext(repo, store));
      const result = await service.start({
        productId: "prod_1",
        revisionId: "rev_1",
        categoryKey: "women.hat",
        selectedAssetIds: ["asset_2", "asset_1"],
        outputCount: 5
      });

      expect(result.batchId).toBe("batch_1");
      expect(store.resolveActiveByCategory).toHaveBeenCalledWith("women.hat");
      expect(repo.createBatch).toHaveBeenCalledWith(
        expect.objectContaining({
          selectedAssetIds: ["asset_2", "asset_1"],
          requestedOutputCount: 5,
          templateVersion: 2,
          templateId: "tmpl_1",
          templateVersionId: "ver_active_1",
          categoryKey: "women.hat",
          revisionId: "rev_1",
          productId: "prod_1",
          productFacts: {
            title: "蕾丝蝴蝶结大帽檐遮阳草帽",
            category: "women.hat",
            attributes: [{ name: "颜色", value: "米白色" }]
          },
          recipe: {
            version: 1,
            inputCount: 2,
            outputCount: 5,
            mustPreserve: [],
            visualDirection: "海边度假场景，商品为主体",
            forbidden: ["改变帽檐结构"],
            roles: [{ key: "hero", instruction: "Hero shot" }],
            providerParameters: {}
          }
        })
      );
    });

    it("uses run intent to distinguish a deliberate new batch while keeping retries idempotent", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      store.resolveActiveByCategory.mockResolvedValue({ template: activeTemplate, version: activeTemplateVersion });
      repo.createBatch.mockResolvedValue({ batchId: "batch_1", plannerJobId: "job_1" });
      const service = new ImageGenerationService(makeContext(repo, store));
      const base = {
        productId: "prod_1",
        revisionId: "rev_1",
        categoryKey: "women.hat",
        selectedAssetIds: ["asset_1"],
        outputCount: 4
      };

      await service.start({ ...base, runIntentId: "intent_1" });
      await service.start({ ...base, runIntentId: "intent_1" });
      await service.start({ ...base, runIntentId: "intent_2" });

      const keys = repo.createBatch.mock.calls.map(([input]) => (input as { idempotencyKey: string }).idempotencyKey);
      expect(keys[0]).toBe(keys[1]);
      expect(keys[2]).not.toBe(keys[0]);
    });

    it("rejects an asset that is not owned by the requested product revision", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.loadStartContext.mockRejectedValue(Object.assign(new Error("asset_not_in_revision"), {
        code: "asset_not_in_revision"
      }));
      store.resolveActiveByCategory.mockResolvedValue({ template: activeTemplate, version: activeTemplateVersion });

      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(service.start({
        productId: "prod_1",
        revisionId: "rev_1",
        categoryKey: "women.hat",
        selectedAssetIds: ["asset_from_other_revision"],
        outputCount: 1
      })).rejects.toMatchObject({ code: "asset_not_in_revision" });
      expect(repo.createBatch).not.toHaveBeenCalled();
    });

    it("rejects duplicate asset IDs", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.start({
          productId: "prod_1",
          revisionId: "rev_1",
          categoryKey: "women.hat",
          selectedAssetIds: ["asset_1", "asset_1", "asset_2"],
          outputCount: 4
        })
      ).rejects.toMatchObject({ code: "duplicate_assets" });
    });

    it("rejects fewer than 1 or more than 6 inputs", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      store.resolveActiveByCategory.mockResolvedValue({ template: activeTemplate, version: activeTemplateVersion });
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.start({
          productId: "prod_1",
          revisionId: "rev_1",
          categoryKey: "women.hat",
          selectedAssetIds: [],
          outputCount: 4
        })
      ).rejects.toMatchObject({ code: "input_count_out_of_range" });

      await expect(
        service.start({
          productId: "prod_1",
          revisionId: "rev_1",
          categoryKey: "women.hat",
          selectedAssetIds: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
          outputCount: 4
        })
      ).rejects.toMatchObject({ code: "input_count_out_of_range" });
    });

    it("rejects fewer than 1 or more than 8 outputs", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      store.resolveActiveByCategory.mockResolvedValue({ template: activeTemplate, version: activeTemplateVersion });
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.start({
          productId: "prod_1",
          revisionId: "rev_1",
          categoryKey: "women.hat",
          selectedAssetIds: ["asset_1"],
          outputCount: 0
        })
      ).rejects.toMatchObject({ code: "output_count_out_of_range" });

      await expect(
        service.start({
          productId: "prod_1",
          revisionId: "rev_1",
          categoryKey: "women.hat",
          selectedAssetIds: ["asset_1"],
          outputCount: 9
        })
      ).rejects.toMatchObject({ code: "output_count_out_of_range" });
    });

    it("rejects when no active template for category", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      store.resolveActiveByCategory.mockResolvedValue(null);
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.start({
          productId: "prod_1",
          revisionId: "rev_1",
          categoryKey: "women.unknown",
          selectedAssetIds: ["asset_1"],
          outputCount: 4
        })
      ).rejects.toMatchObject({ code: "template_not_found" });
    });
  });

  describe("retrySlot", () => {
    it("retries only a failed slot", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_4", slotNumber: 4, role: "hero", state: "failed", attempt: 2, remoteOutputUrl: null, archivedAssetId: null, error: { message: "boom" } }
        ]
      });
      repo.retrySlot.mockResolvedValue(true);

      const service = new ImageGenerationService(makeContext(repo, store));
      const result = await service.retrySlot({ productId: "prod_1", batchId: "batch_1", slotId: "slot_4" });

      expect(result.slotId).toBe("slot_4");
      expect(repo.retrySlot).toHaveBeenCalledWith("slot_4");
    });

    it("throws when slot is not failed", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_1", slotNumber: 1, role: "hero", state: "succeeded", attempt: 1, remoteOutputUrl: "http://img/1.png", archivedAssetId: "arch_1", error: null }
        ]
      });

      const service = new ImageGenerationService(makeContext(repo, store));
      await expect(
        service.retrySlot({ productId: "prod_1", batchId: "batch_1", slotId: "slot_1" })
      ).rejects.toMatchObject({ code: "slot_not_retryable" });
    });

    it("throws when batch not found", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue(null);
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.retrySlot({ productId: "prod_999", batchId: "batch_1", slotId: "slot_1" })
      ).rejects.toMatchObject({ code: "batch_not_found" });
    });

    it("throws when slot not found", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: []
      });
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.retrySlot({ productId: "prod_1", batchId: "batch_1", slotId: "slot_99" })
      ).rejects.toMatchObject({ code: "slot_not_found" });
    });
  });

  describe("excludeSlot", () => {
    it("excludes a waiting or queued slot", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_1", slotNumber: 1, role: "hero", state: "waiting_for_plan", attempt: 0, remoteOutputUrl: null, archivedAssetId: null, error: null }
        ]
      });
      repo.excludeSlotWeb.mockResolvedValue(true);

      const service = new ImageGenerationService(makeContext(repo, store));
      const result = await service.excludeSlot({ productId: "prod_1", batchId: "batch_1", slotId: "slot_1" });

      expect(result.slotId).toBe("slot_1");
      expect(repo.excludeSlotWeb).toHaveBeenCalledWith("slot_1");
    });

    it("throws when slot is not excludable (succeeded)", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_1", slotNumber: 1, role: "hero", state: "succeeded", attempt: 1, remoteOutputUrl: "http://img/1.png", archivedAssetId: "arch_1", error: null }
        ]
      });
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.excludeSlot({ productId: "prod_1", batchId: "batch_1", slotId: "slot_1" })
      ).rejects.toMatchObject({ code: "slot_not_excludable" });
    });
  });

  describe("acceptPartial", () => {
    it("accepts with zero successful non-excluded slots", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_1", slotNumber: 1, role: "hero", state: "failed", attempt: 1, remoteOutputUrl: null, archivedAssetId: null, error: {} },
          { slotId: "slot_2", slotNumber: 2, role: "detail", state: "excluded", attempt: 0, remoteOutputUrl: null, archivedAssetId: null, error: null }
        ]
      });
      const service = new ImageGenerationService(makeContext(repo, store));

      await expect(
        service.acceptPartial({ productId: "prod_1", batchId: "batch_1", orderedSlotIds: [] })
      ).rejects.toMatchObject({ code: "no_successful_slots" });
    });

    it("accepts succeeded slots and calls repository", async () => {
      const repo = mockRepository();
      const store = mockTemplateStore();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_1", slotNumber: 1, role: "hero", state: "succeeded", attempt: 1, remoteOutputUrl: "http://img/1.png", archivedAssetId: "arch_1", error: null },
          { slotId: "slot_2", slotNumber: 2, role: "detail", state: "succeeded", attempt: 1, remoteOutputUrl: "http://img/2.png", archivedAssetId: "arch_2", error: null },
          { slotId: "slot_3", slotNumber: 3, role: "lifestyle", state: "failed", attempt: 1, remoteOutputUrl: null, archivedAssetId: null, error: {} }
        ]
      });
      repo.acceptPartial.mockResolvedValue(undefined);

      const service = new ImageGenerationService(makeContext(repo, store));
      const result = await service.acceptPartial({ productId: "prod_1", batchId: "batch_1", orderedSlotIds: ["slot_1", "slot_2"] });

      expect(result.acceptedAssetIds).toEqual(["arch_1", "arch_2"]);
      expect(repo.acceptPartial).toHaveBeenCalledWith("batch_1", ["arch_1", "arch_2"]);
    });

    it("preserves the operator's slot order when accepting successful outputs", async () => {
      const repo = mockRepository();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_1", slotNumber: 1, role: "hero", state: "succeeded", attempt: 1, remoteOutputUrl: "http://provider/1.png", archivedAssetId: "arch_1", error: null },
          { slotId: "slot_2", slotNumber: 2, role: "detail", state: "succeeded", attempt: 1, remoteOutputUrl: "http://provider/2.png", archivedAssetId: "arch_2", error: null }
        ]
      });
      const service = new ImageGenerationService(makeContext(repo, mockTemplateStore()));

      const result = await service.acceptPartial({
        productId: "prod_1",
        batchId: "batch_1",
        orderedSlotIds: ["slot_2", "slot_1"]
      });

      expect(result.acceptedAssetIds).toEqual(["arch_2", "arch_1"]);
      expect(repo.acceptPartial).toHaveBeenCalledWith("batch_1", ["arch_2", "arch_1"]);
    });

    it.each([
      { orderedSlotIds: ["slot_1", "slot_1"], code: "duplicate_slot_ids" },
      { orderedSlotIds: ["slot_foreign"], code: "slot_not_found" },
      { orderedSlotIds: ["slot_2"], code: "slot_not_successful" }
    ])("rejects invalid partial acceptance: $code", async ({ orderedSlotIds, code }) => {
      const repo = mockRepository();
      repo.getProductProjection.mockResolvedValue({
        productId: "prod_1",
        batchId: "batch_1",
        state: "planning",
        slots: [
          { slotId: "slot_1", slotNumber: 1, role: "hero", state: "succeeded", attempt: 1, remoteOutputUrl: "http://provider/1.png", archivedAssetId: "arch_1", error: null },
          { slotId: "slot_2", slotNumber: 2, role: "detail", state: "failed", attempt: 1, remoteOutputUrl: null, archivedAssetId: null, error: {} }
        ]
      });
      const service = new ImageGenerationService(makeContext(repo, mockTemplateStore()));

      await expect(service.acceptPartial({
        productId: "prod_1",
        batchId: "batch_1",
        orderedSlotIds
      })).rejects.toMatchObject({ code });
      expect(repo.acceptPartial).not.toHaveBeenCalled();
    });
  });
});
