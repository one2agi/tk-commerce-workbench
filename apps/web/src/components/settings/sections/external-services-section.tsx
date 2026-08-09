import type { SecretFieldName, SecretStatusMap } from "../../../../../../packages/contracts/src/runtime-configuration.js";
import type { WorkspaceSettingsView } from "../../../server/services/settings-service";
import { Field } from "../field";
import { SecretField, type SecretDraft, type SecretDraftMap } from "../secret-field";

export interface ExternalServicesSectionProps {
  draft: WorkspaceSettingsView;
  dirtyFields: ReadonlySet<string>;
  secretDrafts: SecretDraftMap;
  errors?: Readonly<Record<string, string>>;
  onFieldChange: (dottedPath: string, value: unknown) => void;
  onSecretChange: (field: SecretFieldName, draft: SecretDraft) => void;
}

const EMPTY_SECRET_STATUS = {
  imagePlannerApiKey: false, imageProviderApiKey: false, canvasApiKey: false, llmApiKey: false,
  miaoshouAppKey: false, miaoshouAppSecret: false, miaoshouAuthorization: false,
  miaoshouCookie: false, assetPublishS3AccessKeyId: false,
  assetPublishS3SecretAccessKey: false, extensionToken: false
} satisfies SecretStatusMap;

export function ExternalServicesSection({
  draft,
  dirtyFields,
  secretDrafts,
  errors = {},
  onFieldChange,
  onSecretChange
}: ExternalServicesSectionProps): React.JSX.Element {
  const config = draft.serviceConfiguration ?? fallbackServiceConfiguration(draft);
  const status = draft.serviceSecretStatus ?? EMPTY_SECRET_STATUS;
  const publicField = (name: keyof typeof config, label: string, help?: string) => (
    <Field
      id={`service-${name}`}
      label={label}
      help={help}
      error={errors[`serviceConfiguration.${name}`]}
      isDirty={dirtyFields.has(`serviceConfiguration.${name}`)}
    >
      <input
        id={`service-${name}`}
        value={config[name]}
        aria-describedby={errors[`serviceConfiguration.${name}`] ? `service-${name}-error` : help ? `service-${name}-help` : undefined}
        aria-invalid={Boolean(errors[`serviceConfiguration.${name}`])}
        onChange={(event) => {
          const value = event.target.value;
          onFieldChange(`serviceConfiguration.${name}`, value);
          if (name === "imagePlannerModel") onFieldChange("providerOptions.imagePlannerModel", value);
          if (name === "imageProviderModel") onFieldChange("providerOptions.imageProviderModel", value);
          if (name === "canvasWorkflowName") onFieldChange("providerOptions.canvasWorkflow", value);
          if (name === "llmModel") onFieldChange("providerOptions.listingModel", value);
        }}
      />
    </Field>
  );
  const secretField = (field: SecretFieldName, label: string, help?: string) => (
    <SecretField
      field={field}
      label={label}
      configured={status[field]}
      draft={secretDrafts[field]}
      help={help}
      onChange={onSecretChange}
    />
  );

  return (
    <div className="tk-service-groups">
      <details className="tk-service-group" open>
        <summary><span><strong>图片生成</strong><small>当前路径：{config.imageGenerationPath === "headless" ? "Headless API" : "Canvas"}</small></span></summary>
        <div className="tk-service-group__body tk-field-grid cols-2">
          {config.imageGenerationPath === "headless" ? <>
            {publicField("imagePlannerBaseUrl", "Planner API 地址", "兼容 OpenAI API 的服务地址")}
            {publicField("imagePlannerModel", "Planner 模型")}
            {secretField("imagePlannerApiKey", "Planner API Key")}
            <span aria-hidden />
            {publicField("imageProviderBaseUrl", "图片 API 地址")}
            {publicField("imageProviderModel", "图片模型")}
            {secretField("imageProviderApiKey", "图片 API Key")}
          </> : <>
            {publicField("canvasBaseUrl", "Canvas 地址")}
            {publicField("canvasId", "Canvas ID")}
            {publicField("canvasWorkflowName", "Canvas 工作流")}
            {secretField("canvasApiKey", "Canvas API Key")}
          </>}
        </div>
      </details>

      <details className="tk-service-group">
        <summary><span><strong>文案与汇率</strong><small>Listing 清洗和汇率换算</small></span></summary>
        <div className="tk-service-group__body tk-field-grid cols-2">
          {publicField("llmBaseUrl", "LLM API 地址")}
          {publicField("llmModel", "LLM 模型")}
          {secretField("llmApiKey", "LLM API Key")}
          {publicField("exchangeRateBaseUrl", "汇率 API 地址")}
        </div>
      </details>

      <details className="tk-service-group">
        <summary><span><strong>妙手发布</strong><small>商品同步与授权信息</small></span></summary>
        <div className="tk-service-group__body tk-field-grid cols-2">
          {publicField("miaoshouBaseUrl", "妙手 API 地址")}
          {publicField("miaoshouAccountId", "妙手账号 ID")}
          {secretField("miaoshouAppKey", "妙手 App Key")}
          {secretField("miaoshouAppSecret", "妙手 App Secret")}
          {secretField("miaoshouAuthorization", "妙手 Authorization")}
          {secretField("miaoshouCookie", "妙手 Cookie")}
        </div>
      </details>

      <details className="tk-service-group">
        <summary><span><strong>素材发布</strong><small>S3 兼容存储</small></span></summary>
        <div className="tk-service-group__body tk-field-grid cols-2">
          {publicField("assetPublishS3Endpoint", "S3 Endpoint")}
          {publicField("assetPublishS3Region", "S3 Region")}
          {publicField("assetPublishS3Bucket", "S3 Bucket")}
          {publicField("assetPublishPublicBaseUrl", "素材公开地址")}
          {secretField("assetPublishS3AccessKeyId", "S3 Access Key ID")}
          {secretField("assetPublishS3SecretAccessKey", "S3 Secret Access Key")}
        </div>
      </details>

      <details className="tk-service-group">
        <summary><span><strong>浏览器扩展</strong><small>采集扩展的访问令牌</small></span></summary>
        <div className="tk-service-group__body">
          {secretField("extensionToken", "扩展访问 Token", "保存后新请求立即使用；旧 Token 立即失效")}
        </div>
      </details>
    </div>
  );
}

function fallbackServiceConfiguration(draft: WorkspaceSettingsView) {
  return {
    imageGenerationPath: draft.providerOptions.imageGenerationPath,
    imagePlannerBaseUrl: "", imagePlannerModel: draft.providerOptions.imagePlannerModel,
    imageProviderBaseUrl: "", imageProviderModel: draft.providerOptions.imageProviderModel,
    canvasBaseUrl: "", canvasId: "", canvasWorkflowName: draft.providerOptions.canvasWorkflow,
    llmBaseUrl: "", llmModel: draft.providerOptions.listingModel, exchangeRateBaseUrl: "",
    miaoshouBaseUrl: "", miaoshouAccountId: "", assetPublishS3Endpoint: "",
    assetPublishS3Region: "", assetPublishS3Bucket: "", assetPublishPublicBaseUrl: ""
  } as const;
}
