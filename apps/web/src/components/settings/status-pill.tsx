export interface StatusPillProps {
  name: string;
  envVars: string;
  configured: boolean;
}

export function StatusPill({ name, envVars, configured }: StatusPillProps): React.JSX.Element {
  return (
    <div
      className={`tk-pill ${configured ? "is-ok" : "is-warn"}`}
      title={envVars}
    >
      <span className="tk-pill__icon" aria-hidden>
        {configured ? "✓" : "!"}
      </span>
      <div className="tk-pill__body">
        <div className="tk-pill__name">{name}</div>
        <div className="tk-pill__env">{envVars}</div>
      </div>
    </div>
  );
}
