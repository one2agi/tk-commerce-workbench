import type { TemplateV1 } from "@tk/contracts/read-models";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";

export function renderTemplatesPage(data: { items: TemplateV1[] }) {
  return <section aria-label="生图模板库">
    <header className="tk-page-heading"><div><p>Canvas</p><h1>模板库</h1></div><span>{data.items.length} 个版本</span></header>
    <div className="tk-card-grid">{data.items.map((template) => <article className="tk-panel" key={`${template.templateId}:${template.version}`}>
      <header><h2>{template.name}</h2><strong>v{template.version}</strong></header>
      <p>{template.promptFragment || "未设置提示词片段"}</p>
      <dl>
        <div><dt>类目规则</dt><dd>{template.categoryRules.map((rule) => `${rule.categoryKey} (${rule.priority})`).join("、") || "默认"}</dd></div>
        <div><dt>参考图</dt><dd>{template.referenceAssetIds.length} 张</dd></div>
        <div><dt>语言</dt><dd>{template.targetLocale}</dd></div>
        <div><dt>风格</dt><dd>{template.visualStyle}</dd></div>
        <div><dt>状态</dt><dd>{template.enabled ? "启用" : "停用"}</dd></div>
      </dl>
      <button type="button" disabled>当前只读，保存尚未开放</button>
    </article>)}</div>
  </section>;
}

export default async function TemplatesPage() {
  return renderTemplatesPage(await (await getServerServices()).templates.list());
}
