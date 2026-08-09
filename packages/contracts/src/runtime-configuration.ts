export type PublicServiceConfigurationV1 = Readonly<{
  imageGenerationPath: "headless" | "canvas";
  imagePlannerBaseUrl: string;
  imagePlannerModel: string;
  imageProviderBaseUrl: string;
  imageProviderModel: string;
  canvasBaseUrl: string;
  canvasId: string;
  canvasWorkflowName: string;
  llmBaseUrl: string;
  llmModel: string;
  exchangeRateBaseUrl: string;
  miaoshouBaseUrl: string;
  miaoshouAccountId: string;
  assetPublishS3Endpoint: string;
  assetPublishS3Region: string;
  assetPublishS3Bucket: string;
  assetPublishPublicBaseUrl: string;
}>;

export const SECRET_FIELD_NAMES = [
  "imagePlannerApiKey",
  "imageProviderApiKey",
  "canvasApiKey",
  "llmApiKey",
  "miaoshouAppKey",
  "miaoshouAppSecret",
  "miaoshouAuthorization",
  "miaoshouCookie",
  "assetPublishS3AccessKeyId",
  "assetPublishS3SecretAccessKey",
  "extensionToken"
] as const;

export type SecretFieldName = typeof SECRET_FIELD_NAMES[number];
export type RuntimeSecretsV1 = Readonly<Partial<Record<SecretFieldName, string>>>;
export type SecretMutation = Readonly<
  { action: "replace"; value: string } |
  { action: "clear" }
>;
export type SecretStatusMap = Readonly<Record<SecretFieldName, boolean>>;

export type EncryptedSecretEnvelopeV1 = Readonly<{
  version: 1;
  nonce: string;
  tag: string;
  ciphertext: string;
}>;

export function secretStatusFromSecrets(secrets: RuntimeSecretsV1): SecretStatusMap {
  return Object.fromEntries(
    SECRET_FIELD_NAMES.map((name) => [name, Boolean(secrets[name]?.trim())])
  ) as unknown as SecretStatusMap;
}
