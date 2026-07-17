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
      <Field label="最多尝试次数" help="含首次执行；1-20" isDirty={dirtyFields.has("retryPolicy.maxAttempts")}>
        <input type="number" min={1} max={20} value={r.maxAttempts} onChange={(e) => onFieldChange("retryPolicy.maxAttempts", Number(e.target.value))} />
      </Field>
      <Field label="首次重试等待（秒）" help="之后按指数退避" isDirty={dirtyFields.has("retryPolicy.initialDelaySeconds")}>
        <input type="number" min={1} value={r.initialDelaySeconds} onChange={(e) => onFieldChange("retryPolicy.initialDelaySeconds", Number(e.target.value))} />
      </Field>
    </div>
  );
}
