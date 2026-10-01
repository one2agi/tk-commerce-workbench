"use client";

import type { ReactElement } from "react";
import {
  STAGE_ORDER,
  type StageKey,
  type StageOverview
} from "./product-workbench.selectors";

type Props = Readonly<{
  overview: StageOverview;
  activeStage: StageKey;
  onSelect: (stage: StageKey) => void;
}>;

export function StageOverview({ overview, activeStage, onSelect }: Props): ReactElement {
  return (
    <section aria-label="阶段看板" className="tk-stage-overview tk-stage-tabs">
      <div className="tk-stage-tabs__list" role="tablist">
        {STAGE_ORDER.map((key) => {
          const card = overview[key];
          const pressed = activeStage === key;
          const cleanName = card.label.replace(/（\d+）$/, "");
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-label={card.label}
              aria-selected={pressed}
              aria-pressed={pressed}
              data-stage={key}
              className={`tk-stage-card tk-stage-tab${pressed ? " is-active" : ""}`}
              onClick={() => onSelect(key)}
            >
              <span className="tk-stage-tab__name">{cleanName}</span>
              <span className="tk-stage-tab__count">{card.count}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
