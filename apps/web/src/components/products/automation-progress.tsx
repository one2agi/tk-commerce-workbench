import type { ReactElement } from "react";

type Node = Readonly<{
  key: string;
  label: string;
  state: "pending" | "running" | "ready" | "failed";
}>;

type Props = Readonly<{
  nodes: ReadonlyArray<Node>;
  productId: string;
}>;

export function AutomationProgress({ nodes, productId }: Props): ReactElement {
  return (
    <ol aria-label={`商品 ${productId} 自动化进度节点`} className="tk-automation-progress">
      {nodes.map((n) => (
        <li key={n.key} data-state={n.state} aria-label={`${n.label} ${n.state}`}>
          <span className="tk-automation-progress__dot" />
          <span className="tk-automation-progress__label">{n.label}</span>
        </li>
      ))}
    </ol>
  );
}
