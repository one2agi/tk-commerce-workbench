import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

export function SystemDiagnosticsSection({ draft }: { draft: WorkspaceSettingsView }): React.JSX.Element {
  const runtime = draft.runtimeStatus;
  const state = runtime.applyState ?? "pending";
  const applied = state === "applied" && runtime.appliedVersion === draft.version;
  const failed = state === "error";
  return (
    <div className="tk-system-diagnostics">
      <div className="tk-runtime-heading">
        <div><strong>配置应用状态</strong><p>保存和 Worker 应用分开确认，避免把“已保存”误认为“已生效”。</p></div>
        <a className="tk-button tk-button--secondary" href="/tasks" aria-label="打开任务日志">打开任务日志</a>
      </div>
      <dl className="tk-runtime-grid">
        <div><dt>已保存版本</dt><dd>v{runtime.savedVersion ?? draft.version}</dd></div>
        <div><dt>Worker 已应用</dt><dd>{runtime.appliedVersion === null || runtime.appliedVersion === undefined ? "尚未应用" : `v${runtime.appliedVersion}`}</dd></div>
        <div><dt>应用状态</dt><dd>{applied ? "已生效" : failed ? "应用失败" : "等待应用"}</dd></div>
        <div><dt>生图路径</dt><dd>{draft.providerOptions.imageGenerationPath === "headless" ? "Headless API" : "Canvas"}</dd></div>
      </dl>
      <div className={`tk-apply-status ${applied ? "is-applied" : failed ? "is-error" : "is-pending"}`}>
        <span aria-hidden>{applied ? "✓" : failed ? "!" : "↻"}</span>
        <div>
          <strong>{applied ? "Worker 已应用当前配置" : failed ? "Worker 保留了上一个可用版本" : "等待 Worker 自动应用"}</strong>
          <p>{applied
            ? `版本 v${draft.version} 已用于新的处理周期。`
            : failed
              ? `当前配置未生效（${runtime.applyErrorCode ?? "配置校验失败"}），现有任务继续使用上一个可用版本。`
              : "当前任务完成后会检查并应用新版本，无需重启容器。"}</p>
        </div>
      </div>
    </div>
  );
}
