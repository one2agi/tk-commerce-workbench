import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export function AdvancedSettingsSection({
  draft
}: {
  draft: WorkspaceSettingsView;
}): React.JSX.Element {
  return (
    <details className="tk-advanced-settings">
      <summary>
        <span>高级设置</span>
        <small>部署环境提供的运行信息</small>
      </summary>
      <div className="tk-field-grid cols-2">
        <div className="tk-field--wide">
          <Field id="assetRoot" label="素材目录" help="由部署环境提供，界面仅展示；如需修改请调整部署配置。">
            <input id="assetRoot" name="assetRoot" aria-describedby="assetRoot-help" type="text" value={draft.runtimeStatus.active.assetRoot} readOnly />
          </Field>
        </div>
      </div>
    </details>
  );
}
