import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export interface PricingFormulaSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

function PctField(props: {
  label: string;
  help: string;
  path: string;
  value: string;
  dirty: boolean;
  onChange: (path: string, v: unknown) => void;
}): React.JSX.Element {
  return (
    <Field label={props.label} help={props.help} isDirty={props.dirty}>
      <input
        type="number"
        step="0.001"
        value={props.value}
        onChange={(e) => props.onChange(props.path, e.target.value)}
      />
    </Field>
  );
}

export function PricingFormulaSection({ draft, dirtyFields, onFieldChange }: PricingFormulaSectionProps): React.JSX.Element {
  const p = draft.pricingDefaults;
  return (
    <div className="tk-field-grid cols-3">
      <Field label="国内运费 CNY" help="每件商品分摊的国内发货成本" isDirty={dirtyFields.has("pricingDefaults.domesticShippingCny")}>
        <input type="number" step="0.01" value={p.domesticShippingCny} onChange={(e) => onFieldChange("pricingDefaults.domesticShippingCny", e.target.value)} />
      </Field>
      <Field label="跨境成本 CNY" help="头程 + 尾程物流综合" isDirty={dirtyFields.has("pricingDefaults.crossBorderCostCny")}>
        <input type="number" step="0.01" value={p.crossBorderCostCny} onChange={(e) => onFieldChange("pricingDefaults.crossBorderCostCny", e.target.value)} />
      </Field>
      <Field label="固定成本 THB" help="包装/标签等" isDirty={dirtyFields.has("pricingDefaults.fixedTargetCostThb")}>
        <input type="number" step="0.01" value={p.fixedTargetCostThb} onChange={(e) => onFieldChange("pricingDefaults.fixedTargetCostThb", e.target.value)} />
      </Field>
      <PctField label="平台费率" help="0.05 = 5%" path="pricingDefaults.platformFeeRate" value={p.platformFeeRate} dirty={dirtyFields.has("pricingDefaults.platformFeeRate")} onChange={onFieldChange} />
      <PctField label="支付费率" help="支付通道手续费" path="pricingDefaults.paymentFeeRate" value={p.paymentFeeRate} dirty={dirtyFields.has("pricingDefaults.paymentFeeRate")} onChange={onFieldChange} />
      <PctField label="目标利润率" help="售价中利润占比" path="pricingDefaults.targetProfitRate" value={p.targetProfitRate} dirty={dirtyFields.has("pricingDefaults.targetProfitRate")} onChange={onFieldChange} />
      <div className="tk-field tk-field--wide">
        <Field label="价格尾数" help="售价尾数；9 表示以 .9 结尾" isDirty={dirtyFields.has("pricingDefaults.ending")}>
          <input
            type="number"
            min={0}
            max={9}
            value={p.ending}
            onChange={(e) => onFieldChange("pricingDefaults.ending", e.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}
