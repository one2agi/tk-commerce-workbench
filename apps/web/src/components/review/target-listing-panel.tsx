import type { ProductWorkspaceV1 } from "@tk/contracts/read-models";

export function TargetListingPanel({ target }: { target: ProductWorkspaceV1["target"] }) {
  return (
    <section aria-label={`${target?.locale ?? "未设置语言"} 目标 Listing`} className="tk-panel tk-review__target">
      <header><span>目标 Listing</span><strong>{target?.locale ?? "未设置"}</strong></header>
      {target ? <>
        <h2>{target.title}</h2>
        <p>{target.description || "暂无目标描述"}</p>
        <dl>
          <div><dt>语言</dt><dd>{target.locale}</dd></div>
          <div><dt>风格</dt><dd>{target.style}</dd></div>
          <div><dt>生成器</dt><dd>{target.provider} / {target.model}</dd></div>
        </dl>
      </> : <p>目标 Listing 尚未生成</p>}
    </section>
  );
}
