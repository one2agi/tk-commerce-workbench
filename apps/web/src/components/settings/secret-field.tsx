import type { SecretFieldName } from "../../../../../packages/contracts/src/runtime-configuration.js";

export type SecretDraft = Readonly<{ value: string; clear: boolean }>;
export type SecretDraftMap = Readonly<Partial<Record<SecretFieldName, SecretDraft>>>;

export function SecretField({
  field,
  label,
  configured,
  draft = { value: "", clear: false },
  help,
  onChange
}: {
  field: SecretFieldName;
  label: string;
  configured: boolean;
  draft?: SecretDraft;
  help?: string;
  onChange: (field: SecretFieldName, draft: SecretDraft) => void;
}): React.JSX.Element {
  const id = `secret-${field}`;
  const effectiveConfigured = configured && !draft.clear;
  return (
    <div className={`tk-secret-field${draft.value || draft.clear ? " is-dirty" : ""}`}>
      <div className="tk-secret-field__head">
        <label htmlFor={id}>{label}</label>
        <span className={effectiveConfigured ? "is-configured" : "is-empty"}>
          {draft.clear ? "保存后移除" : effectiveConfigured ? "已配置" : "未配置"}
        </span>
      </div>
      <div className="tk-secret-field__control">
        <input
          id={id}
          type="password"
          autoComplete="new-password"
          value={draft.value}
          placeholder={effectiveConfigured ? "已配置，输入新值可替换" : "输入后将加密保存"}
          onChange={(event) => onChange(field, { value: event.target.value, clear: false })}
        />
        {configured ? (
          <button
            type="button"
            onClick={() => onChange(field, draft.clear ? { value: "", clear: false } : { value: "", clear: true })}
          >
            {draft.clear ? "撤销移除" : "移除"}
          </button>
        ) : null}
      </div>
      {help ? <small>{help}</small> : null}
    </div>
  );
}
