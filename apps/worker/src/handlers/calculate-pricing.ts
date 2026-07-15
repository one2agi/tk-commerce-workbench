import { calculateTargetPrice } from "@tk/domain/pricing/calculate-price";
import { NeedsInputError, requireFencedWrite, type LeaseFence, type WorkerHandler } from "../runtime/worker-loop.js";

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

function numeric(value: string): number {
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)) return Number.NaN;
  return Number(value);
}

function validatePricingInputs(data: PricingInputs): void {
  const weight = numeric(data.weightKg!);
  const sourceCost = numeric(data.sourceCostCny!);
  const domestic = numeric(data.domesticShippingCny!);
  const crossBorder = numeric(data.crossBorderCostCny!);
  const exchangeRate = numeric(data.exchangeRate!);
  const fixed = numeric(data.fixedTargetCostThb);
  const platform = numeric(data.platformFeeRate);
  const payment = numeric(data.paymentFeeRate);
  const profit = numeric(data.targetProfitRate);
  const allFinite = [weight, sourceCost, domestic, crossBorder, exchangeRate, fixed, platform, payment, profit].every(Number.isFinite);
  const invalid = !allFinite || weight <= 0 || sourceCost < 0 || domestic < 0 || crossBorder < 0 || exchangeRate <= 0 || fixed < 0 ||
    platform < 0 || platform >= 1 || payment < 0 || payment >= 1 || profit < 0 || profit >= 1 || platform + payment + profit >= 1 ||
    !/^\d$/.test(data.ending);
  if (invalid) throw new NeedsInputError("invalid_pricing_input", "Pricing inputs contain an invalid value or rate");
}

export function createPricingHandler(input: {
  repository: {
    loadInputs(revisionId: string): Promise<PricingInputs>;
    saveReady(value: Record<string, unknown>, fence: LeaseFence): Promise<boolean>;
  };
}): WorkerHandler {
  return async (job, execution) => {
    const revisionId = String(job.payload.revisionId ?? "");
    const data = await input.repository.loadInputs(revisionId);
    if (!data.weightKg) throw new NeedsInputError("missing_weight", "Product weight is required for pricing");
    if (!data.sourceCostCny) throw new NeedsInputError("missing_source_cost", "Source cost is required for pricing");
    if (!data.exchangeRate) throw new NeedsInputError("missing_exchange_rate", "A valid exchange rate is required for pricing");
    if (data.domesticShippingCny === null || data.crossBorderCostCny === null) {
      throw new NeedsInputError("missing_shipping_cost", "Shipping costs are required for pricing");
    }
    validatePricingInputs(data);
    let finalPrice: ReturnType<typeof calculateTargetPrice>;
    try {
      finalPrice = calculateTargetPrice({
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
    } catch {
      throw new NeedsInputError("invalid_pricing_input", "Pricing inputs contain an invalid value or rate");
    }
    execution.assertLease();
    requireFencedWrite(await input.repository.saveReady({
      revisionId,
      finalPrice,
      exchangeRateSnapshotId: data.exchangeRateSnapshotId ?? null,
      breakdown: { ...data }
    }, execution.fence));
    return {
      next: [{
        kind: "template_match",
        businessKey: `${revisionId}:template`,
        payload: { version: 1, revisionId }
      }]
    };
  };
}
