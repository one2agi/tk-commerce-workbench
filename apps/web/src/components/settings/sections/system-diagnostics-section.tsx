import type { WorkspaceSettingsView } from "../../../server/services/settings-service";

export function SystemDiagnosticsSection({ draft }: { draft: WorkspaceSettingsView }): React.JSX.Element {
  return (
    <div className="tk-system-diagnostics">
      <p>任务中心已从主导航移除。这里用于排查后台任务、失败恢复和日志追踪。</p>
      <a className="tk-button tk-button--secondary" href="/tasks" aria-label="打开任务日志">
        打开任务日志
      </a>
      <dl>
        <div>
          <dt>运行模式</dt>
          <dd>{draft.externalAdapterMode}</dd>
        </div>
        <div>
          <dt>Canvas</dt>
          <dd>{draft.secretStatus.canvasConfigured ? "已配置" : "未配置"} · TK工作流</dd>
        </div>
        <div>
          <dt>妙手</dt>
          <dd>{draft.secretStatus.miaoshouConfigured ? "已配置" : "未配置"}</dd>
        </div>
        <div>
          <dt>LLM</dt>
          <dd>{draft.secretStatus.llmConfigured ? "已配置" : "未配置"}</dd>
        </div>
      </dl>
    </div>
  );
}
