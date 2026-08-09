import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { StatusPill } from "../status-pill";

export interface SecretStatusSectionProps { draft: WorkspaceSettingsView; }

export function SecretStatusSection({ draft }: SecretStatusSectionProps): React.JSX.Element {
  const status = draft.serviceSecretStatus;
  const legacy = draft.secretStatus;
  const headlessReady = status
    ? status.imagePlannerApiKey && status.imageProviderApiKey
    : draft.runtimeStatus.active.imageGenerationConfigured;
  const canvasReady = status ? status.canvasApiKey : legacy.canvasConfigured;
  const miaoshouReady = status
    ? status.miaoshouAppKey && status.miaoshouAppSecret
    : legacy.miaoshouConfigured;
  const llmReady = status ? status.llmApiKey : legacy.llmConfigured;
  const extensionReady = status?.extensionToken ?? false;
  return (
    <>
      <div className="tk-pill-row">
        <StatusPill name="Headless 生图" envVars="Planner / 图片 Provider" configured={headlessReady} />
        <StatusPill name="Canvas" envVars="兼容链路凭据" configured={canvasReady} />
        <StatusPill name="妙手" envVars="发布授权" configured={miaoshouReady} />
        <StatusPill name="LLM" envVars="Listing 模型凭据" configured={llmReady} />
        <StatusPill name="浏览器扩展" envVars="采集访问 Token" configured={extensionReady} />
      </div>
      <p className="tk-secret-note">密钥只显示配置状态；已有值不会回显。输入新值后保存即可替换。</p>
    </>
  );
}
