"use client";

import { useState, type FormEvent } from "react";
import type { TemplateV1 } from "@tk/contracts/read-models";

function parseRules(value: FormDataEntryValue | null) {
  return String(value ?? "").split("\n").map((line) => line.trim()).filter(Boolean).map((line, index) => ({
    categoryKey: line,
    priority: 100 - index
  }));
}

function parseAssets(value: FormDataEntryValue | null) {
  return String(value ?? "").split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
}

function fields(data: FormData) {
  return {
    name: data.get("name"),
    categoryRules: parseRules(data.get("categoryRules")),
    referenceAssetIds: parseAssets(data.get("referenceAssetIds")),
    promptFragment: data.get("promptFragment"),
    targetLocale: data.get("targetLocale"),
    visualStyle: data.get("visualStyle"),
    enabled: data.get("enabled") === "on"
  };
}

export function TemplateManager({ items }: { items: TemplateV1[] }) {
  const [records, setRecords] = useState(items);
  const [message, setMessage] = useState("");
  const latestVersion = new Map<string, number>();
  for (const item of records) {
    latestVersion.set(item.templateId, Math.max(latestVersion.get(item.templateId) ?? 0, item.version));
  }
  async function send(event: FormEvent<HTMLFormElement>, template?: TemplateV1) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const response = await saveTemplate(fetch, template, data);
    if (response.ok) {
      const saved = response.value;
      setRecords((current) => [saved, ...current]);
      setMessage("已保存为新的不可变模板版本，可继续编辑最新版本。");
    } else {
      setMessage(response.status === 409 ? "模板已有新版本，请刷新后再编辑。" : "模板保存失败，请检查输入。");
    }
  }

  return <><form className="tk-panel" aria-label="新建模板" onSubmit={(event) => send(event)}>
    <h2>新建模板</h2><TemplateFields /><button type="submit">创建模板 v1</button>
  </form>
  <output aria-live="polite">{message}</output>
  <div className="tk-card-grid">{records.map((template) => latestVersion.get(template.templateId) === template.version
    ? <form className="tk-panel" key={`${template.templateId}:${template.version}`} onSubmit={(event) => send(event, template)}>
      <header><h2>{template.name}</h2><strong>v{template.version}</strong></header>
      <TemplateFields template={template} />
      <button type="submit">基于 v{template.version} 创建新版本</button>
    </form>
    : <article className="tk-panel" key={`${template.templateId}:${template.version}`}>
      <header><h2>{template.name}</h2><strong>v{template.version} 历史版本（只读）</strong></header>
      <p>{template.promptFragment || "未设置提示词片段"}</p>
      <p>{template.targetLocale} · {template.visualStyle || "未设置风格"} · {template.enabled ? "当时启用" : "当时停用"}</p>
    </article>)}</div></>;
}

export async function saveTemplate(
  fetcher: typeof fetch,
  template: TemplateV1 | undefined,
  data: FormData
): Promise<{ ok: true; value: TemplateV1 } | { ok: false; status: number }> {
    const response = await fetcher("/api/v1/templates", {
      method: template ? "PATCH" : "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(template ? {
        templateId: template.templateId,
        expectedVersion: template.version,
        ...fields(data)
      } : fields(data))
    });
    return response.ok
      ? { ok: true, value: await response.json() as TemplateV1 }
      : { ok: false, status: response.status };
}

function TemplateFields({ template }: { template?: TemplateV1 }) {
  return <>
    <label>名称<input name="name" defaultValue={template?.name ?? ""} required /></label>
    <label>类目规则（每行一个）<textarea name="categoryRules" defaultValue={template?.categoryRules.map((rule) => rule.categoryKey).join("\n") ?? ""} /></label>
    <label>参考素材 ID（逗号或换行分隔）<textarea name="referenceAssetIds" defaultValue={template?.referenceAssetIds.join("\n") ?? ""} /></label>
    <label>提示词片段<textarea name="promptFragment" defaultValue={template?.promptFragment ?? ""} /></label>
    <label>目标语言<input name="targetLocale" defaultValue={template?.targetLocale ?? "th-TH"} required /></label>
    <label>视觉风格<input name="visualStyle" defaultValue={template?.visualStyle ?? "marketplace"} /></label>
    <label><input name="enabled" type="checkbox" defaultChecked={template?.enabled ?? true} />启用</label>
  </>;
}
