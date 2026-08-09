import type { Metadata } from "next";
import type { ImageGenerationTemplateViewV1 } from "@tk/contracts/read-models";

import { ImageGenerationTemplateManager } from "../../components/templates/image-generation-template-manager";
import { getServerServices } from "../../server/composition";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "生图模板 · TK 商品自动化",
  description: "创建、测试并启用 Headless 生图模板。"
};

export function renderTemplatesPage(data: { items: ImageGenerationTemplateViewV1[] }) {
  return <ImageGenerationTemplateManager items={data.items} />;
}

export default async function TemplatesPage() {
  return renderTemplatesPage(await (await getServerServices()).imageGenerationTemplates.list());
}
