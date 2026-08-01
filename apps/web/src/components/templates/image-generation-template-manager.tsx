"use client";

import { useState, type FormEvent } from "react";
import type { ImageGenerationTemplateViewV1 } from "@tk/contracts/read-models";

type LifecycleState = "draft" | "active" | "archived";

function stateLabel(state: LifecycleState): string {
  switch (state) {
    case "draft": return "草稿";
    case "active": return "进行中";
    case "archived": return "已归档";
  }
}

function stateBadgeClass(state: LifecycleState): string {
  switch (state) {
    case "draft": return "tk-badge-draft";
    case "active": return "tk-badge-active";
    case "archived": return "tk-badge-archived";
  }
}

interface TemplateItemProps {
  template: ImageGenerationTemplateViewV1;
  onRefresh: () => void;
}

function TemplateItem({ template, onRefresh }: TemplateItemProps) {
  const [expanded, setExpanded] = useState(false);
  const [message, setMessage] = useState("");

  async function handleAction(action: string) {
    setMessage("");
    const endpoint = `/api/v1/image-generation-templates/${template.templateId}/${action}`;
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({ version: template.version })
      });
      if (response.ok) {
        setMessage("操作成功");
        onRefresh();
      } else {
        const err = await response.json().catch(() => ({}));
        setMessage(`操作失败: ${err.error ?? response.status}`);
      }
    } catch {
      setMessage("网络错误");
    }
  }

  async function handlePromptTest() {
    setMessage("");
    try {
      const response = await fetch(
        `/api/v1/image-generation-templates/${template.templateId}/prompt-test`,
        {
          method: "POST",
          headers: { "content-type": "application/json", origin: window.location.origin },
          body: JSON.stringify({ productId: "probe", outputCount: template.recipe.outputCounts.default })
        }
      );
      if (response.ok) {
        const data = await response.json();
        setMessage(`提示词测试完成: ${data.prompts?.length ?? 0} 个提示词`);
      } else {
        const err = await response.json().catch(() => ({}));
        setMessage(`测试失败: ${err.error ?? response.status}`);
      }
    } catch {
      setMessage("网络错误");
    }
  }

  return (
    <article className="tk-panel">
      <header className="tk-template-header">
        <div className="tk-template-title">
          <h3>{template.name}</h3>
          <span className={stateBadgeClass(template.lifecycleState)}>{stateLabel(template.lifecycleState)}</span>
        </div>
        <div className="tk-template-meta">
          <span className="tk-template-category">{template.categoryKey}</span>
          <span className="tk-template-version">v{template.version}</span>
        </div>
      </header>

      <div className="tk-template-recipe-summary">
        <span>默认输入: {template.recipe.inputCounts.default} ({template.recipe.inputCounts.min}-{template.recipe.inputCounts.max})</span>
        <span>默认输出: {template.recipe.outputCounts.default} ({template.recipe.outputCounts.min}-{template.recipe.outputCounts.max})</span>
        <span>角色: {template.recipe.roles.map((r) => r.key).join(", ")}</span>
      </div>

      {message && <output className="tk-template-message">{message}</output>}

      <div className="tk-template-actions">
        <button type="button" onClick={handlePromptTest}>
          测试提示词
        </button>

        {template.lifecycleState === "draft" && (
          <button type="button" onClick={() => handleAction("activate")}>
            启用此版本
          </button>
        )}

        {template.lifecycleState === "archived" && (
          <button type="button" onClick={() => handleAction("restore")}>
            恢复为新草稿
          </button>
        )}

        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? "收起设置" : "高级设置"}
        </button>
      </div>

      {expanded && (
        <div className="tk-template-advanced">
          <fieldset>
            <legend>提示词配置</legend>
            <div className="tk-field">
              <label>必须保留</label>
              <ul>
                {template.recipe.mustPreserve.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
                {template.recipe.mustPreserve.length === 0 && <li className="tk-empty">无</li>}
              </ul>
            </div>
            <div className="tk-field">
              <label>视觉方向</label>
              <p>{template.recipe.visualDirection || "未设置"}</p>
            </div>
            <div className="tk-field">
              <label>禁止内容</label>
              <ul>
                {template.recipe.forbidden.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
                {template.recipe.forbidden.length === 0 && <li className="tk-empty">无</li>}
              </ul>
            </div>
          </fieldset>

          <fieldset>
            <legend>角色说明</legend>
            {template.recipe.roles.map((role) => (
              <div key={role.key} className="tk-field">
                <label>{role.key}</label>
                <p>{role.instruction}</p>
              </div>
            ))}
          </fieldset>
        </div>
      )}
    </article>
  );
}

export function ImageGenerationTemplateManager({ items }: { items: ImageGenerationTemplateViewV1[] }) {
  const [templates, setTemplates] = useState(items);
  const [message, setMessage] = useState("");

  function handleRefresh() {
    window.location.reload();
  }

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage("");
    const data = new FormData(event.currentTarget);
    const recipe = {
      inputCounts: { default: 2, min: 1, max: 6 },
      outputCounts: { default: 4, min: 1, max: 8 },
      mustPreserve: [] as string[],
      visualDirection: "",
      forbidden: [] as string[],
      roles: [
        { key: "hero", instruction: "Primary hero shot" },
        { key: "detail", instruction: "Close-up detail view" }
      ]
    };

    try {
      const response = await fetch("/api/v1/image-generation-templates", {
        method: "POST",
        headers: { "content-type": "application/json", origin: window.location.origin },
        body: JSON.stringify({
          name: data.get("name"),
          categoryKey: data.get("categoryKey"),
          recipe
        })
      });
      if (response.ok) {
        setMessage("模板创建成功");
        event.currentTarget.reset();
        handleRefresh();
      } else {
        const err = await response.json().catch(() => ({}));
        setMessage(`创建失败: ${err.error ?? response.status}`);
      }
    } catch {
      setMessage("网络错误");
    }
  }

  return (
    <div className="tk-template-manager">
      <section className="tk-panel">
        <h2>新建模板</h2>
        <form onSubmit={handleCreate}>
          <div className="tk-form-row">
            <label>
              模板名称
              <input name="name" required />
            </label>
            <label>
              类目键值
              <input name="categoryKey" placeholder="例如 women.hat" required />
            </label>
          </div>
          <button type="submit">新建模板</button>
          {message && <output>{message}</output>}
        </form>
      </section>

      <section className="tk-template-list">
        <h2>模板列表</h2>
        {templates.length === 0 ? (
          <p className="tk-empty">暂无模板</p>
        ) : (
          templates.map((t) => (
            <TemplateItem key={`${t.templateId}:${t.version}`} template={t} onRefresh={handleRefresh} />
          ))
        )}
      </section>
    </div>
  );
}
