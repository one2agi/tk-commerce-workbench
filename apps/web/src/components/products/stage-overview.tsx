"use client";

import type { ReactElement } from "react";
import type { StageKey, StageOverview } from "./product-workbench.selectors";

type Props = Readonly<{
  overview: StageOverview;
  activeStage: StageKey;
  onSelect: (stage: StageKey) => void;
}>;

export function StageOverview({ overview, activeStage, onSelect }: Props): ReactElement {
  const order: ReadonlyArray<StageKey> = ["all", "collection", "listing", "miaoshouEdit"];
  return (
    <section aria-label="阶段看板" className="tk-stage-overview">
      {order.map((key) => {
        const card = overview[key];
        const pressed = activeStage === key;
        return (
          <button
            key={key}
            type="button"
            aria-label={card.label}
            aria-pressed={pressed}
            data-stage={key}
            className={`tk-stage-card${pressed ? " is-active" : ""}`}
            onClick={() => onSelect(key)}
          >
            <span className="tk-stage-card__label">{card.label}</span>
          </button>
        );
      })}
    </section>
  );
}