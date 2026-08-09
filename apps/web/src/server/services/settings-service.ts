import type { WorkspaceSettingsViewV1 } from "@tk/contracts/read-models";
import type { DbPool } from "../../../../../packages/db/src/schema/index.js";
import {
  secretStatusFromSecrets,
  type EncryptedSecretEnvelopeV1,
  type PublicServiceConfigurationV1,
  type RuntimeSecretsV1,
  type SecretFieldName,
  type SecretMutation,
  type SecretStatusMap
} from "../../../../../packages/contracts/src/runtime-configuration.js";
import type { RuntimeSecretCodec } from "../../../../../packages/config/src/runtime-secrets.js";
import type { RuntimeConfigurationApplyStatus } from "../../../../../packages/db/src/repositories/runtime-configuration-repository.js";

export type PricingDefaults = Readonly<{
  domesticShippingCny: string;
  crossBorderCostCny: string;
  fixedTargetCostThb: string;
  platformFeeRate: string;
  paymentFeeRate: string;
  targetProfitRate: string;
  ending: string;
}>;

export type ProviderOptions = Readonly<{
  listingProvider: string;
  listingModel: string;
  canvasWorkflow: string;
  imageGenerationPath: "headless" | "canvas";
  imagePlannerModel: string;
  imageProviderModel: string;
}>;

export type RetryPolicy = Readonly<{ maxAttempts: number; initialDelaySeconds: number }>;

export type WorkspaceSettingsRecord = Readonly<{
  version: number;
  defaultLocale: string;
  defaultCurrency: string;
  externalAdapterMode: "mock" | "live";
  workerConcurrency: number;
  maxCanvasRunsPerDay: number;
  assetRoot: string;
  pricingDefaults: PricingDefaults;
  providerOptions: ProviderOptions;
  retryPolicy: RetryPolicy;
  serviceConfiguration?: PublicServiceConfigurationV1;
  encryptedSecrets?: EncryptedSecretEnvelopeV1 | null;
}>;

export type ActiveWorkerRuntime = Readonly<{
  externalAdapterMode: "mock" | "live";
  workerConcurrency: number;
  maxCanvasRunsPerDay: number;
  assetRoot: string;
  imageGenerationPath: "headless" | "canvas";
  imagePlannerModel: string;
  imageProviderModel: string;
  canvasWorkflow: string;
  imageGenerationConfigured: boolean;
}>;

export type WorkspaceSettingsView = Omit<WorkspaceSettingsRecord, "encryptedSecrets"> & Pick<WorkspaceSettingsViewV1, "secretStatus"> & Readonly<{
  serviceConfiguration?: PublicServiceConfigurationV1;
  serviceSecretStatus?: SecretStatusMap;
  applicationNote: string;
  runtimeStatus: {
    active: ActiveWorkerRuntime;
    restartRequiredFields: string[];
    savedVersion?: number;
    appliedVersion?: number | null;
    applyState?: "pending" | "applied" | "error";
    applyErrorCode?: string | null;
  };
}>;

export type SettingsUpdate = Readonly<Partial<Omit<WorkspaceSettingsRecord, "version">> & {
  expectedVersion: number;
  secretMutations?: Partial<Record<SecretFieldName, SecretMutation>>;
}>;

export interface SettingsStore {
  initialize(defaults: WorkspaceSettingsRecord): Promise<void>;
  get(): Promise<WorkspaceSettingsRecord | undefined>;
  update(
    expectedVersion: number,
    next: Omit<WorkspaceSettingsRecord, "version">
  ): Promise<WorkspaceSettingsRecord | undefined>;
}

export class SettingsConflictError extends Error {
  constructor(readonly actualVersion: number) {
    super("settings_version_conflict");
  }
}

export class SettingsValidationError extends Error {
  constructor(readonly code: string, readonly field: string) {
    super(code);
  }
}

type RuntimeSettings = Readonly<{
  defaults: Omit<WorkspaceSettingsRecord, "version">;
  secretStatus: WorkspaceSettingsViewV1["secretStatus"];
  activeRuntime?: ActiveWorkerRuntime;
  secretCodec?: RuntimeSecretCodec;
  loadApplyStatus?: () => Promise<RuntimeConfigurationApplyStatus>;
}>;

export class SettingsService {
  constructor(private readonly store: SettingsStore, private readonly runtime: RuntimeSettings) {}

  async get(): Promise<WorkspaceSettingsView> {
    await this.store.initialize({ ...this.runtime.defaults, version: 1 });
    const record = await this.store.get();
    if (!record) throw new Error("workspace_settings_unavailable");
    return this.toView(record);
  }

  async update(command: SettingsUpdate): Promise<WorkspaceSettingsView> {
    await this.store.initialize({ ...this.runtime.defaults, version: 1 });
    const currentRecord = await this.store.get();
    if (!currentRecord) throw new Error("workspace_settings_unavailable");
    const current = await this.toView(currentRecord);
    const serviceConfiguration = command.serviceConfiguration ??
      currentRecord.serviceConfiguration ?? defaultServiceConfiguration(currentRecord.providerOptions);
    let encryptedSecrets = currentRecord.encryptedSecrets ?? null;
    const hasSecretMutations = Boolean(command.secretMutations && Object.keys(command.secretMutations).length > 0);
    let nextSecrets: RuntimeSecretsV1 = encryptedSecrets && this.runtime.secretCodec
      ? this.runtime.secretCodec.open(encryptedSecrets, "workspace_settings:1")
      : {};
    if (hasSecretMutations) {
      if (!this.runtime.secretCodec) throw new Error("runtime secret codec is unavailable");
      nextSecrets = applySecretMutations(nextSecrets, command.secretMutations!);
      encryptedSecrets = this.runtime.secretCodec.seal(nextSecrets, "workspace_settings:1");
    }
    if (hasSecretMutations || command.serviceConfiguration || command.externalAdapterMode || command.providerOptions) {
      validateRuntimeConfiguration(
        command.externalAdapterMode ?? current.externalAdapterMode,
        serviceConfiguration,
        nextSecrets
      );
    }
    const next: Omit<WorkspaceSettingsRecord, "version"> = {
      defaultLocale: command.defaultLocale ?? current.defaultLocale,
      defaultCurrency: command.defaultCurrency ?? current.defaultCurrency,
      externalAdapterMode: command.externalAdapterMode ?? current.externalAdapterMode,
      workerConcurrency: command.workerConcurrency ?? current.workerConcurrency,
      maxCanvasRunsPerDay: command.maxCanvasRunsPerDay ?? current.maxCanvasRunsPerDay,
      assetRoot: command.assetRoot ?? current.assetRoot,
      pricingDefaults: command.pricingDefaults ?? current.pricingDefaults,
      providerOptions: command.providerOptions ?? current.providerOptions,
      retryPolicy: command.retryPolicy ?? current.retryPolicy,
      serviceConfiguration,
      encryptedSecrets
    };
    const updated = await this.store.update(command.expectedVersion, next);
    if (!updated) {
      const actual = await this.store.get();
      throw new SettingsConflictError(actual?.version ?? current.version);
    }
    return this.toView(updated);
  }

  private async toView(record: WorkspaceSettingsRecord): Promise<WorkspaceSettingsView> {
    const providerOptions = normalizeProviderOptions(record.providerOptions, this.runtime.defaults.providerOptions);
    const activeRuntime = this.runtime.activeRuntime ?? activeRuntimeFromDefaults(this.runtime.defaults);
    const restartRequiredFields = restartRequired(record, providerOptions, activeRuntime);
    const encryptedSecrets = record.encryptedSecrets ?? null;
    const secrets = encryptedSecrets && this.runtime.secretCodec
      ? this.runtime.secretCodec.open(encryptedSecrets, "workspace_settings:1")
      : {};
    const applyStatus = this.runtime.loadApplyStatus
      ? await this.runtime.loadApplyStatus()
      : { appliedVersion: null, candidateVersion: null, state: "pending" as const, errorCode: null };
    const { encryptedSecrets: _encryptedSecrets, ...safeRecord } = record;
    return {
      ...safeRecord,
      pricingDefaults: { ...record.pricingDefaults },
      providerOptions,
      retryPolicy: { ...record.retryPolicy },
      secretStatus: { ...this.runtime.secretStatus },
      serviceConfiguration: record.serviceConfiguration ?? defaultServiceConfiguration(providerOptions),
      serviceSecretStatus: secretStatusFromSecrets(secrets),
      runtimeStatus: {
        active: { ...activeRuntime },
        restartRequiredFields,
        savedVersion: record.version,
        appliedVersion: applyStatus.appliedVersion,
        applyState: applyStatus.state,
        applyErrorCode: applyStatus.errorCode
      },
      applicationNote: "保存后 Worker 会在下一个处理周期自动应用有效配置，无需重启容器。"
    };
  }
}

function applySecretMutations(
  current: RuntimeSecretsV1,
  mutations: Partial<Record<SecretFieldName, SecretMutation>>
): RuntimeSecretsV1 {
  const next: Partial<Record<SecretFieldName, string>> = { ...current };
  for (const [field, mutation] of Object.entries(mutations) as Array<[SecretFieldName, SecretMutation]>) {
    if (mutation.action === "clear") delete next[field];
    else next[field] = mutation.value.trim();
  }
  return next;
}

function validateRuntimeConfiguration(
  mode: "mock" | "live",
  config: PublicServiceConfigurationV1,
  secrets: RuntimeSecretsV1
): void {
  if (mode !== "live" || config.imageGenerationPath !== "headless") return;
  if (!config.imagePlannerBaseUrl.trim()) throw new SettingsValidationError("image_planner_base_url_required", "imagePlannerBaseUrl");
  if (!config.imagePlannerModel.trim()) throw new SettingsValidationError("image_planner_model_required", "imagePlannerModel");
  if (!secrets.imagePlannerApiKey?.trim()) throw new SettingsValidationError("image_planner_api_key_required", "imagePlannerApiKey");
  if (!config.imageProviderBaseUrl.trim()) throw new SettingsValidationError("image_provider_base_url_required", "imageProviderBaseUrl");
  if (!config.imageProviderModel.trim()) throw new SettingsValidationError("image_provider_model_required", "imageProviderModel");
  if (!secrets.imageProviderApiKey?.trim()) throw new SettingsValidationError("image_provider_api_key_required", "imageProviderApiKey");
}

function defaultServiceConfiguration(provider: ProviderOptions): PublicServiceConfigurationV1 {
  return {
    imageGenerationPath: provider.imageGenerationPath,
    imagePlannerBaseUrl: "",
    imagePlannerModel: provider.imagePlannerModel,
    imageProviderBaseUrl: "",
    imageProviderModel: provider.imageProviderModel,
    canvasBaseUrl: "",
    canvasId: "0f91cb2d8f2846c091829af30ea2d18d",
    canvasWorkflowName: provider.canvasWorkflow,
    llmBaseUrl: "",
    llmModel: provider.listingModel,
    exchangeRateBaseUrl: "",
    miaoshouBaseUrl: "",
    miaoshouAccountId: "",
    assetPublishS3Endpoint: "",
    assetPublishS3Region: "",
    assetPublishS3Bucket: "",
    assetPublishPublicBaseUrl: ""
  };
}

function activeRuntimeFromDefaults(defaults: Omit<WorkspaceSettingsRecord, "version">): ActiveWorkerRuntime {
  return {
    externalAdapterMode: defaults.externalAdapterMode,
    workerConcurrency: defaults.workerConcurrency,
    maxCanvasRunsPerDay: defaults.maxCanvasRunsPerDay,
    assetRoot: defaults.assetRoot,
    imageGenerationPath: defaults.providerOptions.imageGenerationPath,
    imagePlannerModel: defaults.providerOptions.imagePlannerModel,
    imageProviderModel: defaults.providerOptions.imageProviderModel,
    canvasWorkflow: defaults.providerOptions.canvasWorkflow,
    imageGenerationConfigured: false
  };
}

function normalizeProviderOptions(value: ProviderOptions, defaults: ProviderOptions): ProviderOptions {
  const legacy = value as Partial<ProviderOptions>;
  return {
    listingProvider: legacy.listingProvider ?? defaults.listingProvider,
    listingModel: legacy.listingModel ?? defaults.listingModel,
    canvasWorkflow: legacy.canvasWorkflow ?? defaults.canvasWorkflow,
    imageGenerationPath: legacy.imageGenerationPath === "headless" ? "headless" :
      legacy.imageGenerationPath === "canvas" ? "canvas" : defaults.imageGenerationPath,
    imagePlannerModel: legacy.imagePlannerModel ?? defaults.imagePlannerModel,
    imageProviderModel: legacy.imageProviderModel ?? defaults.imageProviderModel
  };
}

function restartRequired(
  record: WorkspaceSettingsRecord,
  providerOptions: ProviderOptions,
  active: ActiveWorkerRuntime
): string[] {
  const fields: string[] = [];
  if (record.externalAdapterMode !== active.externalAdapterMode) fields.push("externalAdapterMode");
  if (record.workerConcurrency !== active.workerConcurrency) fields.push("workerConcurrency");
  if (record.maxCanvasRunsPerDay !== active.maxCanvasRunsPerDay) fields.push("maxCanvasRunsPerDay");
  if (record.assetRoot !== active.assetRoot) fields.push("assetRoot");
  if (providerOptions.imageGenerationPath !== active.imageGenerationPath) fields.push("providerOptions.imageGenerationPath");
  if (providerOptions.imagePlannerModel !== active.imagePlannerModel) fields.push("providerOptions.imagePlannerModel");
  if (providerOptions.imageProviderModel !== active.imageProviderModel) fields.push("providerOptions.imageProviderModel");
  if (providerOptions.canvasWorkflow !== active.canvasWorkflow) fields.push("providerOptions.canvasWorkflow");
  return fields;
}

export class PgSettingsStore implements SettingsStore {
  constructor(private readonly pool: DbPool) {}

  async initialize(defaults: WorkspaceSettingsRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspace_settings
        (id, default_locale, default_currency, external_adapter_mode, worker_concurrency,
         max_canvas_runs_per_day, asset_root, pricing_defaults, provider_options, retry_policy,
         service_configuration, encrypted_secrets, version)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12)
       ON CONFLICT (id) DO UPDATE SET
         service_configuration = EXCLUDED.service_configuration,
         encrypted_secrets = EXCLUDED.encrypted_secrets,
         updated_at = now()
       WHERE workspace_settings.encrypted_secrets IS NULL
         AND EXCLUDED.encrypted_secrets IS NOT NULL`,
      [defaults.defaultLocale, defaults.defaultCurrency, defaults.externalAdapterMode,
        defaults.workerConcurrency, defaults.maxCanvasRunsPerDay, defaults.assetRoot,
        JSON.stringify(defaults.pricingDefaults), JSON.stringify(defaults.providerOptions),
        JSON.stringify(defaults.retryPolicy), JSON.stringify(defaults.serviceConfiguration ?? defaultServiceConfiguration(defaults.providerOptions)),
        defaults.encryptedSecrets ? JSON.stringify(defaults.encryptedSecrets) : null, defaults.version]
    );
  }

  async get(): Promise<WorkspaceSettingsRecord | undefined> {
    const result = await this.pool.query(
      `SELECT default_locale, default_currency, external_adapter_mode, worker_concurrency,
              max_canvas_runs_per_day, asset_root, pricing_defaults, provider_options,
              retry_policy, service_configuration, encrypted_secrets, version
       FROM workspace_settings WHERE id = 1`
    );
    return result.rows[0] ? mapSettings(result.rows[0] as Record<string, unknown>) : undefined;
  }

  async update(expectedVersion: number, next: Omit<WorkspaceSettingsRecord, "version">) {
    const result = await this.pool.query(
      `UPDATE workspace_settings SET
         default_locale = $2, default_currency = $3, external_adapter_mode = $4,
         worker_concurrency = $5, max_canvas_runs_per_day = $6, asset_root = $7,
         pricing_defaults = $8::jsonb, provider_options = $9::jsonb, retry_policy = $10::jsonb,
         service_configuration = $11::jsonb, encrypted_secrets = $12::jsonb,
         version = version + 1, updated_at = now()
       WHERE id = 1 AND version = $1
       RETURNING default_locale, default_currency, external_adapter_mode, worker_concurrency,
                 max_canvas_runs_per_day, asset_root, pricing_defaults, provider_options,
                 retry_policy, service_configuration, encrypted_secrets, version`,
      [expectedVersion, next.defaultLocale, next.defaultCurrency, next.externalAdapterMode,
        next.workerConcurrency, next.maxCanvasRunsPerDay, next.assetRoot,
        JSON.stringify(next.pricingDefaults), JSON.stringify(next.providerOptions),
        JSON.stringify(next.retryPolicy), JSON.stringify(next.serviceConfiguration ?? defaultServiceConfiguration(next.providerOptions)),
        next.encryptedSecrets ? JSON.stringify(next.encryptedSecrets) : null]
    );
    return result.rows[0] ? mapSettings(result.rows[0] as Record<string, unknown>) : undefined;
  }
}

function mapSettings(row: Record<string, unknown>): WorkspaceSettingsRecord {
  return {
    defaultLocale: String(row.default_locale),
    defaultCurrency: String(row.default_currency),
    externalAdapterMode: row.external_adapter_mode === "live" ? "live" : "mock",
    workerConcurrency: Number(row.worker_concurrency),
    maxCanvasRunsPerDay: Number(row.max_canvas_runs_per_day),
    assetRoot: String(row.asset_root),
    pricingDefaults: row.pricing_defaults as PricingDefaults,
    providerOptions: row.provider_options as ProviderOptions,
    retryPolicy: row.retry_policy as RetryPolicy,
    serviceConfiguration: row.service_configuration as PublicServiceConfigurationV1,
    encryptedSecrets: row.encrypted_secrets as EncryptedSecretEnvelopeV1 | null,
    version: Number(row.version)
  };
}
