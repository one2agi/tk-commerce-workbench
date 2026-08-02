import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { StatusPill } from "../status-pill";

export interface SecretStatusSectionProps {
  draft: WorkspaceSettingsView;
}

export function SecretStatusSection({ draft }: SecretStatusSectionProps): React.JSX.Element {
  const s = draft.secretStatus;
  const imageGenerationPathLabel = s.imageGenerationPath === "headless" ? "无头" : "Canvas";
  return (
    <>
      <div className="tk-pill-row">
        <StatusPill name="妙手" envVars="MIAOSHOU_APP_KEY / MIAOSHOU_APP_SECRET" configured={s.miaoshouConfigured} />
        <StatusPill name="图片生成" envVars="IMAGE_GENERATION_PATH" configured={s.imageGenerationConfigured} />
        <StatusPill name="路径" envVars="IMAGE_GENERATION_PATH" configured={true} activeLabel={imageGenerationPathLabel} />
        <StatusPill name="Canvas" envVars="CANVAS_API_KEY" configured={s.canvasConfigured} />
        <StatusPill name="LLM" envVars="LLM_API_KEY" configured={s.llmConfigured} />
        <StatusPill name="汇率" envVars="EXCHANGE_RATE_API_KEY" configured={s.exchangeRateConfigured} />
      </div>
      {s.imageGenerationConfigured && (
        <p style={{ margin: "14px 0 0", color: "var(--muted)", fontSize: "12px" }}>
          图片生成已配置
        </p>
      )}
      <p style={{ margin: "14px 0 0", color: "var(--muted)", fontSize: "12px" }}>
        密钥不会进入浏览器或保存到本页面。在
        <code style={{ background: "#f1f5f9", padding: "1px 4px", borderRadius: "3px", margin: "0 4px" }}>
          ~/.local/share/tk-commerce-workbench/.env
        </code>
        中设置后，重启 Worker 进程即可生效。
      </p>
    </>
  );
}
