import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";

export interface BasicSettingsSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
}

const LOCALES = ["zh-CN", "th-TH", "en-US"] as const;
const CURRENCIES = ["CNY", "THB", "USD"] as const;
const MODES = ["mock", "live"] as const;

export function BasicSettingsSection({ draft, dirtyFields, onFieldChange }: BasicSettingsSectionProps): React.JSX.Element {
  return (
    <div className="tk-field-grid cols-2">
      <Field label="默认语言" help="新建商品时默认使用">
        <select value={draft.defaultLocale} onChange={(e) => onFieldChange("defaultLocale", e.target.value)}>
          {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Field>
      <Field label="默认币种" help="利润换算的目标币种">
        <select value={draft.defaultCurrency} onChange={(e) => onFieldChange("defaultCurrency", e.target.value)}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field label="Provider 模式" help="mock = 仅本地模拟；live = 真实调用外部 API" isDirty={dirtyFields.has("externalAdapterMode")}>
        <select value={draft.externalAdapterMode} onChange={(e) => onFieldChange("externalAdapterMode", e.target.value as "mock" | "live")}>
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field label="Worker 并发" help="同时处理的商品任务数" isDirty={dirtyFields.has("workerConcurrency")}>
        <input
          type="number"
          min={1}
          max={32}
          value={draft.workerConcurrency}
          onChange={(e) => onFieldChange("workerConcurrency", Number(e.target.value))}
        />
      </Field>
      <Field label="Canvas 每日上限" help="0 表示不限制" isDirty={dirtyFields.has("maxCanvasRunsPerDay")}>
        <input
          type="number"
          min={1}
          value={draft.maxCanvasRunsPerDay}
          onChange={(e) => onFieldChange("maxCanvasRunsPerDay", Number(e.target.value))}
        />
      </Field>
      <div className="tk-field tk-field--wide">
        <Field label="素材目录" help="Worker 写文件的绝对路径" isDirty={dirtyFields.has("assetRoot")}>
          <input
            type="text"
            value={draft.assetRoot}
            onChange={(e) => onFieldChange("assetRoot", e.target.value)}
          />
        </Field>
      </div>
    </div>
  );
}
