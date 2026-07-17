import type { ReactNode } from "react";

export interface FieldProps {
  label: string;
  help?: string;
  error?: string;
  isDirty?: boolean;
  children: ReactNode;
}

export function Field({ label, help, error, isDirty, children }: FieldProps): React.JSX.Element {
  return (
    <label className="tk-field">
      <span className="tk-field__label">{label}</span>
      <span className={`tk-field__control${isDirty ? " is-dirty" : ""}`}>
        {children}
        {isDirty ? <span className="tk-field__dirty-dot" aria-hidden /> : null}
      </span>
      {error ? (
        <span className="tk-field__error" role="alert">{error}</span>
      ) : help ? (
        <span className="tk-field__help">{help}</span>
      ) : null}
    </label>
  );
}
