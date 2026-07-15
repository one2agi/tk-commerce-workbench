// Target price calculator: pure, deterministic, BigInt-based. Accepts decimal strings
// only — no float drift. Snaps the final integer minor-units to the requested ending digit.
//
// Order of operations:
//   1. Sum src minor units (CNY fen).
//   2. Apply FX rate -> target minor units (THB satang), rounded half-down.
//   3. Add fixed target cost (in target minor units).
//   4. Divide by the retained revenue rate (1 - fees - target profit), rounding upward.
//   5. Snap upward to the requested ending digit.

import { strict as assert } from "node:assert";

import { thb, type MoneyWire } from "@tk/contracts";

export interface CalculateTargetPriceInput {
  sourceCostCny: string;       // CNY major as decimal string
  domesticShippingCny: string; // CNY major as decimal string
  crossBorderCostCny: string;  // CNY major as decimal string
  cnyToTargetRate: string;     // CNY->THB rate as decimal string
  fixedTargetCostThb: string;  // THB major as decimal string
  platformFeeRate: string;     // decimal e.g. "0.05"
  paymentFeeRate: string;      // decimal e.g. "0.03"
  targetProfitRate: string;    // decimal e.g. "0.30"
  ending: string;              // single digit "0"-"9"
}

const POW10_2 = 100n;
const POW10_4 = 10_000n;

// Decimal strings -> minor units (multiply by 100 for THB/CNY major).
function decimalToMinor(value: string): bigint {
  assert(value && value.length > 0, "decimal value must be non-empty");
  assert(/^-?\d+(\.\d+)?$/.test(value), `decimal value invalid: ${value}`);
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const idx = body.indexOf(".");
  const intPart = idx === -1 ? body : body.slice(0, idx);
  const fracPartRaw = idx === -1 ? "" : body.slice(idx + 1);
  const fracPart = (fracPartRaw + "00").slice(0, 2); // pad to 2 places
  const minor = BigInt(intPart) * POW10_2 + BigInt(fracPart);
  return negative ? -minor : minor;
}

// Decimal rate like "0.05" -> basis points (multiply by 10000).
function decimalRateToBps(value: string): bigint {
  assert(value && value.length > 0, "rate must be non-empty");
  assert(/^-?\d+(\.\d+)?$/.test(value), `rate invalid: ${value}`);
  const negative = value.startsWith("-");
  const body = negative ? value.slice(1) : value;
  const idx = body.indexOf(".");
  const intPart = idx === -1 ? body : body.slice(0, idx);
  const fracPartRaw = idx === -1 ? "" : body.slice(idx + 1);
  const fracPart = (fracPartRaw + "0000").slice(0, 4); // pad to 4 places
  const bps = BigInt(intPart) * POW10_4 + BigInt(fracPart);
  return negative ? -bps : bps;
}

// floor(x*rate) helper that mirrors standard accounting math.
// rate is given as a normalized decimal string like "4.80" -> bps 48000.
function applyFx(srcMinor: bigint, fxBps: bigint): bigint {
  // Multiply then floor; rate bps 4dp.
  return (srcMinor * fxBps) / POW10_4;
}

function snapEnding(value: bigint, ending: string): bigint {
  assert(/^[0-9]$/.test(ending), `ending must be a single digit: ${ending}`);
  const lastDigit = value % 10n;
  const target = BigInt(ending);
  if (lastDigit === target) return value;
  if (lastDigit < target) return value + (target - lastDigit);
  // lastDigit > target → step up 10 + (target - lastDigit).
  return value + (10n - lastDigit) + target;
}

export function calculateTargetPrice(input: CalculateTargetPriceInput): MoneyWire {
  const fxBps = decimalRateToBps(input.cnyToTargetRate);
  const platformBps = decimalRateToBps(input.platformFeeRate);
  const paymentBps = decimalRateToBps(input.paymentFeeRate);
  const profitBps = decimalRateToBps(input.targetProfitRate);

  // 1. CNY minor (fen): sum three CNY major amounts as fen (×100).
  const srcMinor =
    decimalToMinor(input.sourceCostCny) +
    decimalToMinor(input.domesticShippingCny) +
    decimalToMinor(input.crossBorderCostCny);

  // 2. FX to THB minor (satang) — rate is CNY->THB, want THB minor.
  const fxMinor = applyFx(srcMinor, fxBps);
  // 3. Fixed target cost added in THB minor.
  const fixedMinor = decimalToMinor(input.fixedTargetCostThb);

  // Fees and profit are percentages of the final selling price. Divide the
  // landed cost by the retained share and round upward so the configured
  // margin is never reduced by minor-unit truncation.
  const retainedBps = POW10_4 - platformBps - paymentBps - profitBps;
  assert(retainedBps > 0n, "combined fee and profit rates must be below 1");
  const landedMinor = fxMinor + fixedMinor;
  const numerator = landedMinor * POW10_4;
  const raw = (numerator + retainedBps - 1n) / retainedBps;
  const snapped = snapEnding(raw, input.ending);

  return thb(snapped.toString());
}
