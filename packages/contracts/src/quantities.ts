// Money, weight, dimension types. Decimal strings for amounts/units so JSON can round-trip
// without losing precision and BigInt overflow. The single codec lives in @tk/domain
// (BigInt arithmetic is forbidden in this package).

export type MoneyCurrency = "CNY" | "THB";

export type MoneyWire = Readonly<{
  amountMinor: string; // integer minor units encoded as decimal string
  currency: MoneyCurrency;
}>;

export type WeightKg = Readonly<{
  value: string; // decimal string
  unit: "kg";
}>;

export type DimensionsCm = Readonly<{
  length: string; // decimal string
  width: string; // decimal string
  height: string; // decimal string
  unit: "cm";
}>;

export type ExchangeRateSnapshotWire = Readonly<{
  base: MoneyCurrency;       // e.g. "CNY"
  target: MoneyCurrency;     // e.g. "THB"
  rate: string;              // decimal string, e.g. "4.80"
  source: "provider" | "manual";
  observedAt: string;        // ISO timestamp
  isStale: boolean;
}>;

export function zeroMoney(currency: MoneyCurrency): MoneyWire {
  return { amountMinor: "0", currency };
}

export function cny(value: string | bigint): MoneyWire {
  return { amountMinor: value.toString(), currency: "CNY" };
}

export function thb(value: string | bigint): MoneyWire {
  return { amountMinor: value.toString(), currency: "THB" };
}

export function weightKg(value: string | number): WeightKg {
  return { value: typeof value === "string" ? value : value.toString(), unit: "kg" };
}

export function dimensionsCm(length: string | number, width: string | number, height: string | number): DimensionsCm {
  return {
    length: typeof length === "string" ? length : length.toString(),
    width: typeof width === "string" ? width : width.toString(),
    height: typeof height === "string" ? height : height.toString(),
    unit: "cm"
  };
}
