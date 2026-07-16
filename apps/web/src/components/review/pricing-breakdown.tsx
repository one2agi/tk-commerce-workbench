import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

function displayPrice(pricing: ProductWorkspaceV1["pricing"]): string {
  if (!pricing?.finalPriceWire) return "待计算";
  const amount = Number(pricing.finalPriceWire.amountMinor) / 100;
  return `${amount.toFixed(2)} ${pricing.finalPriceWire.currency}`;
}

export function PricingBreakdown({ pricing }: { pricing: ProductWorkspaceV1["pricing"] }) {
  return (
    <section aria-label="定价公式" className="tk-panel">
      <header><h2>自动定价</h2><strong>{displayPrice(pricing)}</strong></header>
      {pricing ? <ol>
        {Object.entries(pricing.breakdown).map(([key, value]) => <li key={key}>
          <span>{key}</span><strong>{value}</strong>
        </li>)}
      </ol> : <p>等待定价节点完成</p>}
    </section>
  );
}
