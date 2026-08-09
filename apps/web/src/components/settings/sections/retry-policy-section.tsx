import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export interface RetryPolicySectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

export function RetryPolicySection({ draft, dirtyFields, onFieldChange }: RetryPolicySectionProps): React.JSX.Element {
  const r = draft.retryPolicy;
  return (
    <div className="tk-field-grid cols-2">
      <Field id="maxAttempts" label="默认最多尝试次数" help="用于新任务；工作流明确指定上限时以工作流为准" isDirty={dirtyFields.has("retryPolicy.maxAttempts")}>
        <input id="maxAttempts" name="maxAttempts" aria-describedby="maxAttempts-help" type="number" min={1} max={20} value={r.maxAttempts} onChange={(e) => onFieldChange("retryPolicy.maxAttempts", Number(e.target.value))} />
      </Field>
      <Field id="initialDelaySeconds" label="默认重试等待（秒）" help="外部服务未指定等待时间时使用" isDirty={dirtyFields.has("retryPolicy.initialDelaySeconds")}>
        <input id="initialDelaySeconds" name="initialDelaySeconds" aria-describedby="initialDelaySeconds-help" type="number" min={1} max={86400} value={r.initialDelaySeconds} onChange={(e) => onFieldChange("retryPolicy.initialDelaySeconds", Number(e.target.value))} />
      </Field>
    </div>
  );
}
