import type { TemplateV1 } from "@tk/contracts/read-models";
import { getServerServices } from "../../server/composition";
import { TemplateManager } from "../../components/templates/template-manager";

export const dynamic = "force-dynamic";

export function renderTemplatesPage(data: { items: TemplateV1[] }) {
  return <section aria-label="生图模板库">
    <header className="tk-page-heading"><div><p>Canvas</p><h1>模板库</h1></div><span>{data.items.length} 个版本</span></header>
    <p>每次保存都会创建新版本；旧版本继续保留，用于历史审批和结果复现。</p>
    <TemplateManager items={data.items} />
  </section>;
}

export default async function TemplatesPage() {
  return renderTemplatesPage(await (await getServerServices()).templates.list());
}
