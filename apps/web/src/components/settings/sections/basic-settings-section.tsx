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
      <Field id="defaultLocale" label="默认语言" help="新建商品时默认使用" isDirty={dirtyFields.has("defaultLocale")}>
        <select id="defaultLocale" name="defaultLocale" aria-describedby="defaultLocale-help" value={draft.defaultLocale} onChange={(e) => onFieldChange("defaultLocale", e.target.value)}>
          {LOCALES.map((l) => <option key={l} value={l}>{l}</option>)}
        </select>
      </Field>
      <Field id="defaultCurrency" label="默认币种" help="利润换算的目标币种" isDirty={dirtyFields.has("defaultCurrency")}>
        <select id="defaultCurrency" name="defaultCurrency" aria-describedby="defaultCurrency-help" value={draft.defaultCurrency} onChange={(e) => onFieldChange("defaultCurrency", e.target.value)}>
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
      </Field>
      <Field id="externalAdapterMode" label="运行模式" help="测试模式不会调用外部服务；生产模式会执行真实任务" isDirty={dirtyFields.has("externalAdapterMode")}>
        <select id="externalAdapterMode" name="externalAdapterMode" aria-describedby="externalAdapterMode-help" value={draft.externalAdapterMode} onChange={(e) => onFieldChange("externalAdapterMode", e.target.value as "mock" | "live")}>
          {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </Field>
      <Field id="workerConcurrency" label="Worker 并发" help="同时处理的商品任务数；重启 Worker 后生效" isDirty={dirtyFields.has("workerConcurrency")}>
        <input
          id="workerConcurrency"
          name="workerConcurrency"
          aria-describedby="workerConcurrency-help"
          type="number"
          min={1}
          max={32}
          value={draft.workerConcurrency}
          onChange={(e) => onFieldChange("workerConcurrency", Number(e.target.value))}
        />
      </Field>
    </div>
  );
}
