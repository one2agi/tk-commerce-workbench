import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export interface ProviderOptionsSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
  errors?: Readonly<Record<string, string>>;
}

export function ProviderOptionsSection({ draft, dirtyFields, onFieldChange, errors = {} }: ProviderOptionsSectionProps): React.JSX.Element {
  const p = draft.providerOptions;
  return (
    <div className="tk-generation-settings">
      <fieldset className="tk-path-picker">
        <legend>生图路径</legend>
        <label className={p.imageGenerationPath === "headless" ? "is-selected" : ""}>
          <input type="radio" name="imageGenerationPath" value="headless" checked={p.imageGenerationPath === "headless"} onChange={() => onFieldChange("providerOptions.imageGenerationPath", "headless")} />
          <span><strong>Headless API</strong><small>通过 Planner 和图片模型自动完成</small></span>
        </label>
        <label className={p.imageGenerationPath === "canvas" ? "is-selected" : ""}>
          <input type="radio" name="imageGenerationPath" value="canvas" checked={p.imageGenerationPath === "canvas"} onChange={() => onFieldChange("providerOptions.imageGenerationPath", "canvas")} />
          <span><strong>Canvas 兼容</strong><small>继续使用现有 Canvas 工作流</small></span>
        </label>
      </fieldset>

      {p.imageGenerationPath === "headless" ? (
        <div className="tk-field-grid cols-2">
          <Field id="imagePlannerModel" label="Planner 模型" help="负责分析商品并生成图片提示词" error={errors["providerOptions.imagePlannerModel"]} isDirty={dirtyFields.has("providerOptions.imagePlannerModel")}>
            <input id="imagePlannerModel" name="imagePlannerModel" aria-describedby={`imagePlannerModel-${errors["providerOptions.imagePlannerModel"] ? "error" : "help"}`} aria-invalid={Boolean(errors["providerOptions.imagePlannerModel"])} type="text" value={p.imagePlannerModel} onChange={(e) => onFieldChange("providerOptions.imagePlannerModel", e.target.value)} />
          </Field>
          <Field id="imageProviderModel" label="图片模型" help="实际生成商品图的模型 ID" error={errors["providerOptions.imageProviderModel"]} isDirty={dirtyFields.has("providerOptions.imageProviderModel")}>
            <input id="imageProviderModel" name="imageProviderModel" aria-describedby={`imageProviderModel-${errors["providerOptions.imageProviderModel"] ? "error" : "help"}`} aria-invalid={Boolean(errors["providerOptions.imageProviderModel"])} type="text" value={p.imageProviderModel} onChange={(e) => onFieldChange("providerOptions.imageProviderModel", e.target.value)} />
          </Field>
        </div>
      ) : (
        <div className="tk-field-grid cols-2">
          <Field id="canvasWorkflow" label="Canvas 工作流" help="Worker 调用的工作流名称" error={errors["providerOptions.canvasWorkflow"]} isDirty={dirtyFields.has("providerOptions.canvasWorkflow")}>
            <input id="canvasWorkflow" name="canvasWorkflow" aria-describedby={`canvasWorkflow-${errors["providerOptions.canvasWorkflow"] ? "error" : "help"}`} type="text" value={p.canvasWorkflow} onChange={(e) => onFieldChange("providerOptions.canvasWorkflow", e.target.value)} />
          </Field>
          <Field id="maxCanvasRunsPerDay" label="Canvas 每日上限" help="0 表示不限次数；重启 Worker 后生效" error={errors.maxCanvasRunsPerDay} isDirty={dirtyFields.has("maxCanvasRunsPerDay")}>
            <input id="maxCanvasRunsPerDay" name="maxCanvasRunsPerDay" aria-describedby={`maxCanvasRunsPerDay-${errors.maxCanvasRunsPerDay ? "error" : "help"}`} type="number" min={0} max={10000} value={draft.maxCanvasRunsPerDay} onChange={(e) => onFieldChange("maxCanvasRunsPerDay", Number(e.target.value))} />
          </Field>
        </div>
      )}
    </div>
  );
}
