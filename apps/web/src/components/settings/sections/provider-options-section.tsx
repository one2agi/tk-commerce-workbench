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
    <>
      <p>
        Canvas 当前运行工作流为 <code>TK工作流</code>。此页面显示工作区默认值；Worker 实际运行依赖启动配置，
        修改后需要确认 Worker 是否重启并读取最新配置。
      </p>
      <div className="tk-field-grid cols-2">
        <Field label="Listing Provider" help="用于标题和 Listing 清洗的默认 Provider" isDirty={dirtyFields.has("providerOptions.listingProvider")}>
          <input type="text" value={p.listingProvider} onChange={(e) => onFieldChange("providerOptions.listingProvider", e.target.value)} />
        </Field>
        <Field label="Listing Model" help="Provider 对应的模型 ID" isDirty={dirtyFields.has("providerOptions.listingModel")}>
          <input type="text" value={p.listingModel} onChange={(e) => onFieldChange("providerOptions.listingModel", e.target.value)} />
        </Field>
        <div className="tk-field tk-field--wide">
          <span className="tk-field__label">Canvas 工作流</span>
          <p>
            当前绑定：<code>{p.canvasWorkflow || "TK工作流"}</code>；本期不在前端配置额外 Canvas 素材或视觉参数，
            产品识别由 Canvas 工作流内部处理。
          </p>
        </div>
      </div>
    </>
  );
}
