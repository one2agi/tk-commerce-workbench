import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export function AdvancedSettingsSection({
  draft,
  dirtyFields,
  onFieldChange
}: {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}): React.JSX.Element {
  return (
    <details className="tk-advanced-settings">
      <summary>
        <span>高级设置</span>
        <small>素材路径与 Listing 技术参数</small>
      </summary>
      <div className="tk-field-grid cols-2">
        <div className="tk-field--wide">
          <Field id="assetRoot" label="素材目录" help="Worker 写入文件的绝对路径；重启 Worker 后生效" isDirty={dirtyFields.has("assetRoot")}>
            <input id="assetRoot" name="assetRoot" aria-describedby="assetRoot-help" type="text" value={draft.assetRoot} onChange={(event) => onFieldChange("assetRoot", event.target.value)} />
          </Field>
        </div>
        <Field id="listingProvider" label="Listing Provider" help="用于标题和 Listing 清洗" isDirty={dirtyFields.has("providerOptions.listingProvider")}>
          <input id="listingProvider" name="listingProvider" aria-describedby="listingProvider-help" type="text" value={draft.providerOptions.listingProvider} onChange={(event) => onFieldChange("providerOptions.listingProvider", event.target.value)} />
        </Field>
        <Field id="listingModel" label="Listing 模型" help="Provider 对应的模型 ID" isDirty={dirtyFields.has("providerOptions.listingModel")}>
          <input id="listingModel" name="listingModel" aria-describedby="listingModel-help" type="text" value={draft.providerOptions.listingModel} onChange={(event) => onFieldChange("providerOptions.listingModel", event.target.value)} />
        </Field>
      </div>
    </details>
  );
}
