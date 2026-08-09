"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import type { ImageGenerationTemplateViewV1 } from "@tk/contracts/read-models";
import type { PlannedImagePromptV1 } from "@tk/contracts/ports";

type LifecycleState = "draft" | "active" | "archived";
type Recipe = ImageGenerationTemplateViewV1["recipe"];

function stateLabel(state: LifecycleState): string {
  switch (state) {
    case "draft": return "草稿";
    case "active": return "已启用";
    case "archived": return "已归档";
  }
}

function stateBadgeClass(state: LifecycleState): string {
  return `tk-badge-${state}`;
}

function lines(value: string): string[] {
  return value.split("\n").map((item) => item.trim()).filter(Boolean);
}

function lifecycleRank(state: LifecycleState): number {
  return state === "active" ? 0 : state === "draft" ? 1 : 2;
}

function createErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message === "category_key_exists") {
    return "这个类目标识已经有模板，请编辑现有模板或换一个标识。";
  }
  if (error instanceof Error && error.message === "invalid_request") {
    return "类目标识格式不正确，请使用小写英文、数字、点、短横线或下划线。";
  }
  return "模板创建失败，请检查名称和类目标识后重试。";
}

export function PromptTestResults({ prompts }: { prompts: PlannedImagePromptV1[] }) {
  if (prompts.length === 0) return null;
  return (
    <section className="tk-prompt-test-results" aria-label="提示词测试结果">
      <div className="tk-prompt-test-results__heading">
        <strong>提示词测试结果</strong>
        <span>{prompts.length} 条</span>
      </div>
      <p>不会创建图片任务，但会产生提示词模型费用。</p>
      <ol>
        {prompts.map((item) => (
          <li key={`${item.slot}:${item.role}`}>
            <div><strong>#{item.slot} · {item.role}</strong></div>
            <p>{item.prompt}</p>
          </li>
        ))}
      </ol>
    </section>
  );
}

function TemplateItem({ template, onRefresh }: {
  template: ImageGenerationTemplateViewV1;
  onRefresh: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [sampleProductId, setSampleProductId] = useState("");
  const [promptResults, setPromptResults] = useState<PlannedImagePromptV1[]>([]);
  const [recipe, setRecipe] = useState<Recipe>(() => structuredClone(template.recipe));

  function updateCounts(kind: "inputCounts" | "outputCounts", field: "default" | "min" | "max", value: number) {
    setRecipe((current) => ({ ...current, [kind]: { ...current[kind], [field]: value } }));
  }

  async function postAction(action: "activate" | "restore") {
    setPending(action);
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/image-generation-templates/${template.templateId}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: template.version })
      });
      if (!response.ok) throw new Error(String((await response.json().catch(() => ({})) as { error?: unknown }).error ?? response.status));
      setMessage({ text: action === "activate" ? "已启用此版本" : "已恢复为新草稿", error: false });
      onRefresh();
    } catch {
      setMessage({ text: action === "activate" ? "启用失败，请刷新后重试。" : "恢复失败，请刷新后重试。", error: true });
    } finally {
      setPending(null);
    }
  }

  async function saveDraft() {
    setPending("save");
    setMessage(null);
    try {
      const response = await fetch(`/api/v1/image-generation-templates/${template.templateId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ expectedVersion: template.version, recipe })
      });
      if (!response.ok) throw new Error(String((await response.json().catch(() => ({})) as { error?: unknown }).error ?? response.status));
      setMessage({ text: `已保存为新草稿版本 v${template.version + 1}，当前已启用版本没有被修改。`, error: false });
      onRefresh();
    } catch {
      setMessage({ text: "保存失败；历史版本未被修改，请刷新后重试。", error: true });
    } finally {
      setPending(null);
    }
  }

  async function testPrompt() {
    if (!sampleProductId.trim()) return;
    setPending("test");
    setMessage(null);
    setPromptResults([]);
    try {
      const response = await fetch(`/api/v1/image-generation-templates/${template.templateId}/prompt-test`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          productId: sampleProductId.trim(),
          outputCount: recipe.outputCounts.default,
          version: template.version
        })
      });
      if (!response.ok) throw new Error(String((await response.json().catch(() => ({})) as { error?: unknown }).error ?? response.status));
      const data = await response.json() as { prompts?: PlannedImagePromptV1[] };
      setPromptResults(data.prompts ?? []);
      setMessage({ text: `提示词测试完成：生成 ${data.prompts?.length ?? 0} 条提示词，不会启动洗图。`, error: false });
    } catch (error) {
      const text = error instanceof Error && error.message === "product_not_found"
        ? "没有找到这个样例商品，请复制商品处理台中的有效商品 ID。"
        : error instanceof Error && error.message === "runtime_configuration_unavailable"
          ? "当前生图配置尚未生效，请先到设置页检查运行状态。"
          : "提示词测试失败，没有启动洗图任务。";
      setMessage({ text, error: true });
    } finally {
      setPending(null);
    }
  }

  const disabled = pending !== null;
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
        <span>输入 {template.recipe.inputCounts.default} 张（{template.recipe.inputCounts.min}-{template.recipe.inputCounts.max}）</span>
        <span>输出 {template.recipe.outputCounts.default} 张（{template.recipe.outputCounts.min}-{template.recipe.outputCounts.max}）</span>
        <span>{template.recipe.roles.length} 个图片角色</span>
      </div>

      {message ? <output className={message.error ? "tk-template-message is-error" : "tk-template-message"}>{message.text}</output> : null}

      <div className="tk-template-actions">
        {template.lifecycleState === "draft" ? <button type="button" disabled={disabled} onClick={() => void postAction("activate")}>{pending === "activate" ? "正在启用…" : "启用此版本"}</button> : null}
        {template.lifecycleState === "archived" ? <button type="button" disabled={disabled} onClick={() => void postAction("restore")}>{pending === "restore" ? "正在恢复…" : "恢复为新草稿"}</button> : null}
        <button type="button" disabled={disabled} onClick={() => setExpanded((current) => !current)}>{expanded ? "收起设置" : "高级设置"}</button>
      </div>

      {expanded ? (
        <div className="tk-template-advanced">
          <fieldset disabled={disabled || template.lifecycleState === "archived"}>
            <legend>模板内容</legend>
            <div className="tk-template-count-editor">
              {(["inputCounts", "outputCounts"] as const).map((kind) => (
                <div key={kind}>
                  <strong>{kind === "inputCounts" ? "输入图片" : "输出图片"}</strong>
                  {(["min", "default", "max"] as const).map((field) => (
                    <label key={field}>{field === "min" ? "最少" : field === "max" ? "最多" : "默认"}
                      <input name={`${template.templateId}-${kind}-${field}`} type="number" min="1" max={kind === "inputCounts" ? 6 : 8} value={recipe[kind][field]} onChange={(event) => updateCounts(kind, field, Number(event.target.value))} />
                    </label>
                  ))}
                </div>
              ))}
            </div>
            <label>必须保留（每行一项）
              <textarea name={`${template.templateId}-must-preserve`} value={recipe.mustPreserve.join("\n")} onChange={(event) => setRecipe((current) => ({ ...current, mustPreserve: lines(event.target.value) }))} />
            </label>
            <label>视觉方向
              <textarea name={`${template.templateId}-visual-direction`} value={recipe.visualDirection} onChange={(event) => setRecipe((current) => ({ ...current, visualDirection: event.target.value }))} />
            </label>
            <label>禁止内容（每行一项）
              <textarea name={`${template.templateId}-forbidden`} value={recipe.forbidden.join("\n")} onChange={(event) => setRecipe((current) => ({ ...current, forbidden: lines(event.target.value) }))} />
            </label>
            <div className="tk-template-role-editor">
              <strong>图片角色说明</strong>
              {recipe.roles.map((role, index) => (
                <div key={`${role.key}:${index}`}>
                  <input name={`${template.templateId}-role-${index + 1}-key`} aria-label={`角色 ${index + 1} 名称`} value={role.key} onChange={(event) => setRecipe((current) => ({ ...current, roles: current.roles.map((item, roleIndex) => roleIndex === index ? { ...item, key: event.target.value } : item) }))} />
                  <textarea name={`${template.templateId}-role-${index + 1}-instruction`} aria-label={`角色 ${index + 1} 说明`} value={role.instruction} onChange={(event) => setRecipe((current) => ({ ...current, roles: current.roles.map((item, roleIndex) => roleIndex === index ? { ...item, instruction: event.target.value } : item) }))} />
                </div>
              ))}
            </div>
            <button type="button" onClick={() => void saveDraft()}>{pending === "save" ? "正在保存…" : "保存为新草稿版本"}</button>
          </fieldset>
          <fieldset disabled={disabled}>
            <legend>测试提示词</legend>
            <label>样例商品 ID
              <input name={`${template.templateId}-sample-product-id`} autoComplete="off" value={sampleProductId} onChange={(event) => setSampleProductId(event.target.value)} placeholder="例如 prod_ms1tnmsvx2sxoh0r" />
            </label>
            <small>只生成提示词，不会创建图片任务；会产生提示词模型费用。</small>
            <button type="button" disabled={disabled || !sampleProductId.trim()} onClick={() => void testPrompt()}>{pending === "test" ? "正在测试…" : "测试提示词"}</button>
            <PromptTestResults prompts={promptResults} />
          </fieldset>
        </div>
      ) : null}
    </article>
  );
}

export function ImageGenerationTemplateManager({ items }: { items: ImageGenerationTemplateViewV1[] }) {
  const router = useRouter();
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [creating, setCreating] = useState(false);
  const categoryKeys = [...new Set(items.map((item) => item.categoryKey))].sort();
  const sortedItems = [...items].sort((left, right) =>
    lifecycleRank(left.lifecycleState) - lifecycleRank(right.lifecycleState) ||
    right.createdAt.localeCompare(left.createdAt)
  );

  async function handleCreate(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setCreating(true);
    setMessage(null);
    const form = event.currentTarget;
    const data = new FormData(form);
    const recipe = {
      inputCounts: { default: 2, min: 1, max: 6 }, outputCounts: { default: 4, min: 1, max: 8 },
      mustPreserve: [] as string[], visualDirection: "", forbidden: [] as string[],
      roles: [{ key: "hero", instruction: "商品主体主图" }, { key: "detail", instruction: "商品细节特写" }]
    };
    try {
      const response = await fetch("/api/v1/image-generation-templates", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: data.get("name"), categoryKey: data.get("categoryKey"), recipe })
      });
      const result = await response.json().catch(() => ({})) as { error?: unknown };
      if (!response.ok) throw new Error(typeof result.error === "string" ? result.error : "create_failed");
      setMessage({ text: "模板草稿已创建，可在高级设置中调整并启用。", error: false });
      form.reset();
      router.refresh();
    } catch (error) {
      setMessage({ text: createErrorMessage(error), error: true });
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="tk-template-manager">
      <header className="tk-page-heading">
        <div>
          <p>Headless image generation</p>
          <h1>生图模板</h1>
        </div>
      </header>
      <p className="tk-template-intro">为不同商品类目设置图片数量、视觉方向和图片角色。只有已启用模板会进入生图流程。</p>
      <section className="tk-panel">
        <h2>新建模板</h2>
        <form onSubmit={(event) => void handleCreate(event)}>
          <div className="tk-form-row">
            <label>模板名称<input name="name" autoComplete="off" required /></label>
            <label>类目标识
              <input
                name="categoryKey"
                list="image-template-category-keys"
                pattern="[a-z0-9]+(?:[._-][a-z0-9]+)*"
                placeholder="例如 women.hat"
                aria-describedby="image-template-category-help"
                required
              />
            </label>
            <datalist id="image-template-category-keys">
              {categoryKeys.map((categoryKey) => <option key={categoryKey} value={categoryKey} />)}
            </datalist>
          </div>
          <p id="image-template-category-help" className="tk-field-help">使用稳定的小写标识，例如 women.hat；商品生图时会按已启用模板选择。</p>
          <button type="submit" disabled={creating}>{creating ? "正在创建…" : "新建模板"}</button>
          {message ? <output className={message.error ? "tk-template-message is-error" : "tk-template-message"}>{message.text}</output> : null}
        </form>
      </section>
      <section className="tk-template-list">
        <h2>模板列表</h2>
        {sortedItems.length === 0 ? <p className="tk-empty">尚未创建模板。创建并启用后，Headless 生图才能按类目生成图片。</p> : sortedItems.map((template) => (
          <TemplateItem key={`${template.templateId}:${template.version}:${template.lifecycleState}`} template={template} onRefresh={() => router.refresh()} />
        ))}
      </section>
    </div>
  );
}
