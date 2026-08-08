import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

export function SystemDiagnosticsSection({ draft }: { draft: WorkspaceSettingsView }): React.JSX.Element {
  const active = draft.runtimeStatus.active;
  const saved = draft.providerOptions;
  return (
    <div className="tk-system-diagnostics">
      <div className="tk-runtime-heading">
        <div>
          <strong>当前启动值</strong>
          <p>由 Web 进程的启动环境读取，用于核对 Worker；页面不会声明 Worker 已热更新。</p>
        </div>
        <a className="tk-button tk-button--secondary" href="/tasks" aria-label="打开任务日志">打开任务日志</a>
      </div>
      <dl className="tk-runtime-grid">
        <div>
          <dt>运行模式</dt>
          <dd>{active.externalAdapterMode === "live" ? "生产" : "测试"}</dd>
        </div>
        <div>
          <dt>生图路径</dt>
          <dd>{active.imageGenerationPath === "headless" ? "Headless API" : "Canvas"}</dd>
        </div>
        <div>
          <dt>Planner 模型</dt>
          <dd>{active.imagePlannerModel || "未设置"}</dd>
        </div>
        <div>
          <dt>图片模型</dt>
          <dd>{active.imageProviderModel || "未设置"}</dd>
        </div>
      </dl>
      <div className={`tk-apply-status${draft.runtimeStatus.restartRequiredFields.length ? " is-pending" : " is-applied"}`}>
        <span aria-hidden>{draft.runtimeStatus.restartRequiredFields.length ? "↻" : "✓"}</span>
        <div>
          <strong>{draft.runtimeStatus.restartRequiredFields.length ? "重启 Worker 后生效" : "工作区与启动值一致"}</strong>
          <p>{draft.runtimeStatus.restartRequiredFields.length
            ? `已保存配置与当前运行值有 ${draft.runtimeStatus.restartRequiredFields.length} 项不同。请先同步服务器启动配置，再重启 Worker。`
            : `启动值中的生图路径为 ${saved.imageGenerationPath === "headless" ? "Headless API" : "Canvas"}；若 Worker 独立部署，请继续核对其运行环境。`}</p>
        </div>
      </div>
    </div>
  );
}
