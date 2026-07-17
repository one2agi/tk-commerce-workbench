import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export interface ProviderOptionsSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

export function ProviderOptionsSection({ draft, dirtyFields, onFieldChange }: ProviderOptionsSectionProps): React.JSX.Element {
  const p = draft.providerOptions;
  return (
    <div className="tk-field-grid cols-2">
      <Field label="Listing Provider" help='可选值：miaoshou / custom' isDirty={dirtyFields.has("providerOptions.listingProvider")}>
        <input type="text" value={p.listingProvider} onChange={(e) => onFieldChange("providerOptions.listingProvider", e.target.value)} />
      </Field>
      <Field label="Listing Model" help="Provider 对应的模型 ID" isDirty={dirtyFields.has("providerOptions.listingModel")}>
        <input type="text" value={p.listingModel} onChange={(e) => onFieldChange("providerOptions.listingModel", e.target.value)} />
      </Field>
      <div className="tk-field tk-field--wide">
        <Field label="Canvas 工作流" help="在 Canvas 后台创建的工作流 ID" isDirty={dirtyFields.has("providerOptions.canvasWorkflow")}>
          <input type="text" value={p.canvasWorkflow} onChange={(e) => onFieldChange("providerOptions.canvasWorkflow", e.target.value)} />
        </Field>
      </div>
    </div>
  );
}
