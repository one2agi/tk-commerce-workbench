import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { StatusPill } from "../status-pill";

export interface SecretStatusSectionProps {
  draft: WorkspaceSettingsView;
}

export function SecretStatusSection({ draft }: SecretStatusSectionProps): React.JSX.Element {
  const s = draft.secretStatus;
  return (
    <>
      <div className="tk-pill-row">
        <StatusPill name="妙手" envVars="MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET" configured={s.miaoshouConfigured} />
        <StatusPill name="Canvas" envVars="Canvas 连接信息" configured={s.canvasConfigured} />
        <StatusPill name="Headless 生图" envVars="Planner / 图片 Provider" configured={draft.runtimeStatus.active.imageGenerationConfigured} />
        <StatusPill name="汇率" envVars="汇率服务连接信息" configured={s.exchangeRateConfigured} />
      </div>
      <p className="tk-secret-note">
        页面只显示是否就绪，不会读取、返回或保存密钥与服务地址。请在服务器运行环境中维护敏感配置。
      </p>
    </>
  );
}
