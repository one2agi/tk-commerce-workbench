import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export interface ProviderOptionsSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
  errors?: Readonly<Record<string, string>>;
}

export function ProviderOptionsSection({ draft, dirtyFields, onFieldChange, errors = {} }: ProviderOptionsSectionProps): React.JSX.Element {
  const path = draft.providerOptions.imageGenerationPath;
  const selectPath = (next: "headless" | "canvas") => {
    onFieldChange("providerOptions.imageGenerationPath", next);
    onFieldChange("serviceConfiguration.imageGenerationPath", next);
  };
  return (
    <div className="tk-generation-settings">
      <fieldset className="tk-path-picker">
        <legend>生图路径</legend>
        <label className={path === "headless" ? "is-selected" : ""}>
          <input type="radio" name="imageGenerationPath" value="headless" checked={path === "headless"} onChange={() => selectPath("headless")} />
          <span><strong>Headless API</strong><small>通过 Planner 和图片模型自动完成</small></span>
        </label>
        <label className={path === "canvas" ? "is-selected" : ""}>
          <input type="radio" name="imageGenerationPath" value="canvas" checked={path === "canvas"} onChange={() => selectPath("canvas")} />
          <span><strong>Canvas 兼容</strong><small>继续使用现有 Canvas 工作流</small></span>
        </label>
      </fieldset>

      {path === "canvas" ? (
        <div className="tk-field-grid cols-2">
          <Field id="maxCanvasRunsPerDay" label="Canvas 每日上限" help="0 表示不限次数；保存后自动应用" error={errors.maxCanvasRunsPerDay} isDirty={dirtyFields.has("maxCanvasRunsPerDay")}>
            <input id="maxCanvasRunsPerDay" name="maxCanvasRunsPerDay" aria-describedby={`maxCanvasRunsPerDay-${errors.maxCanvasRunsPerDay ? "error" : "help"}`} type="number" min={0} max={10000} value={draft.maxCanvasRunsPerDay} onChange={(event) => onFieldChange("maxCanvasRunsPerDay", Number(event.target.value))} />
          </Field>
        </div>
      ) : <p className="tk-inline-note">Planner、图片模型及 API Key 在下方“外部服务”中配置。</p>}
    </div>
  );
}
