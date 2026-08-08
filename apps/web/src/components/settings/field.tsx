import type { ReactNode } from "react";

export interface FieldProps {
  id: string;
  label: string;
  help?: string;
  error?: string;
  isDirty?: boolean;
  children: ReactNode;
}

export function Field({ id, label, help, error, isDirty, children }: FieldProps): React.JSX.Element {
  const descriptionId = `${id}-${error ? "error" : "help"}`;
  return (
    <div className="tk-field">
      <label className="tk-field__label" htmlFor={id}>{label}</label>
      <span className={`tk-field__control${isDirty ? " is-dirty" : ""}`}>
        {children}
        {isDirty ? <span className="tk-field__dirty-dot" aria-hidden /> : null}
      </span>
      {error ? (
        <span id={descriptionId} className="tk-field__error" role="alert">{error}</span>
      ) : help ? (
        <span id={descriptionId} className="tk-field__help">{help}</span>
      ) : null}
    </div>
  );
}
