import type { ReactNode } from "react";

export interface SettingsCardProps {
  title: string;
  hint?: string;
  dirtyCount?: number;
  ariaLabel: string;
  children: ReactNode;
}

export function SettingsCard({ title, hint, dirtyCount, ariaLabel, children }: SettingsCardProps): React.JSX.Element {
  return (
    <section className="tk-settings-card" aria-label={ariaLabel}>
      <header className="tk-settings-card__head">
        <span className="tk-settings-card__accent" aria-hidden />
        <div className="tk-settings-card__title">
          <h2>{title}</h2>
          {hint ? <span className="tk-settings-card__hint">{hint}</span> : null}
        </div>
        {dirtyCount && dirtyCount > 0 ? (
          <span className="tk-settings-card__dirty">已改 {dirtyCount} 项</span>
        ) : null}
      </header>
      <div className="tk-settings-card__body">{children}</div>
    </section>
  );
}
