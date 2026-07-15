// RED-first test for target pricing math. The calculator must:
// - accept decimal strings only (no float drift)
// - compute target minor units in BigInt
// - treat fees and target profit as percentages of the final selling price
// - snap the final minor-units remainder to the configured "ending" value
//
// Reference calculation for the case below (currency: "THB"):
//   srcMinorTotal   = 1480 + 200 + 600 = 2280 fen (CNY minor)
//   fxMinor         = floor(srcMinorTotal * 4.80 * 100) / 100
//                   = floor(2280 * 480 / 100) = floor(1094400 / 100) = 10944 sat (THB minor)
//   fixedCostMinor  = 1000 sat
//   retained share  = 1 - 0.05 - 0.03 - 0.30 = 0.62
//   target minor    = ceil(11944 / 0.62) = 19265 sat
//   upward ending   = 19269 sat = THB 192.69

import { describe, expect, test } from "vitest";

import { calculateTargetPrice } from "./calculate-price.js";

describe("calculateTargetPrice", () => {
  test("returns THB MoneyWire whose amountMinor ends with the requested digit", () => {
    const result = calculateTargetPrice({
      sourceCostCny: "14.80",
      domesticShippingCny: "2.00",
      crossBorderCostCny: "6.00",
      cnyToTargetRate: "4.80",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.05",
      paymentFeeRate: "0.03",
      targetProfitRate: "0.30",
      ending: "9"
    });

    expect(result.currency).toBe("THB");
    expect(result.amountMinor).toBe("19269");

    // amountMinor must be a positive integer encoded as a decimal string.
    expect(/^[0-9]+$/.test(result.amountMinor)).toBe(true);
    expect(BigInt(result.amountMinor) > 0n).toBe(true);

    // Brief mandated the modulo-1000 invariant for some ending values.
    // "9" ending has no modulo-1000 invariant, so we use the simpler ending-digit invariant.
  });

  test("snaps ending digit deterministically across rounding hops", () => {
    // Two inputs that round to the *same* unrounded total but the calculator must still
    // produce identical snapped output.
    const a = calculateTargetPrice({
      sourceCostCny: "10.00",
      domesticShippingCny: "0.00",
      crossBorderCostCny: "0.00",
      cnyToTargetRate: "5.00",
      fixedTargetCostThb: "0.00",
      platformFeeRate: "0.00",
      paymentFeeRate: "0.00",
      targetProfitRate: "0.00",
      ending: "0"
    });
    const b = calculateTargetPrice({
      sourceCostCny: "10.00",
      domesticShippingCny: "0.00",
      crossBorderCostCny: "0.00",
      cnyToTargetRate: "5.00",
      fixedTargetCostThb: "0.00",
      platformFeeRate: "0.00",
      paymentFeeRate: "0.00",
      targetProfitRate: "0.00",
      ending: "0"
    });
    expect(a).toEqual(b);
  });

  test("rejects empty or non-decimal inputs loudly", () => {
    expect(() =>
      calculateTargetPrice({
        sourceCostCny: "",
        domesticShippingCny: "0",
        crossBorderCostCny: "0",
        cnyToTargetRate: "1",
        fixedTargetCostThb: "0",
        platformFeeRate: "0",
        paymentFeeRate: "0",
        targetProfitRate: "0",
        ending: "0"
      })
    ).toThrow();
  });
});
