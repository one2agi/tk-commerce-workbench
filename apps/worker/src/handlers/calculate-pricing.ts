import { calculateTargetPrice } from "@tk/domain/pricing/calculate-price";
import { NeedsInputError, type WorkerHandler } from "../runtime/worker-loop.js";

export interface PricingInputs {
  weightKg: string | null;
  sourceCostCny: string | null;
  domesticShippingCny: string | null;
  crossBorderCostCny: string | null;
  exchangeRate: string | null;
  exchangeRateSnapshotId?: string | null;
  fixedTargetCostThb: string;
  platformFeeRate: string;
  paymentFeeRate: string;
  targetProfitRate: string;
  ending: string;
}

export function createPricingHandler(input: {
  repository: {
    loadInputs(revisionId: string): Promise<PricingInputs>;
    saveReady(value: Record<string, unknown>): Promise<unknown>;
  };
}): WorkerHandler {
  return async (job) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const data = await input.repository.loadInputs(revisionId);
    if (!data.weightKg) throw new NeedsInputError("missing_weight", "Product weight is required for pricing");
    if (!data.sourceCostCny) throw new NeedsInputError("missing_source_cost", "Source cost is required for pricing");
    if (!data.exchangeRate) throw new NeedsInputError("missing_exchange_rate", "A valid exchange rate is required for pricing");
    if (data.domesticShippingCny === null || data.crossBorderCostCny === null) {
      throw new NeedsInputError("missing_shipping_cost", "Shipping costs are required for pricing");
    }
    const finalPrice = calculateTargetPrice({
      sourceCostCny: data.sourceCostCny,
      domesticShippingCny: data.domesticShippingCny,
      crossBorderCostCny: data.crossBorderCostCny,
      cnyToTargetRate: data.exchangeRate,
      fixedTargetCostThb: data.fixedTargetCostThb,
      platformFeeRate: data.platformFeeRate,
      paymentFeeRate: data.paymentFeeRate,
      targetProfitRate: data.targetProfitRate,
      ending: data.ending
    });
    await input.repository.saveReady({
      revisionId,
      finalPrice,
      exchangeRateSnapshotId: data.exchangeRateSnapshotId ?? null,
      breakdown: { ...data }
    });
    return {
      next: [{
        kind: "canvas_generate",
        businessKey: `${revisionId}:canvas`,
        payload: { version: 1, revisionId }
      }]
    };
  };
}
