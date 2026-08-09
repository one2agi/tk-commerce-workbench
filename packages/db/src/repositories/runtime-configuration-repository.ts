import type {
  EncryptedSecretEnvelopeV1,
  PublicServiceConfigurationV1
} from "../../../contracts/src/runtime-configuration.js";

import type { DbPool } from "../schema/index.js";

export type RuntimeConfigurationCandidate = Readonly<{
  version: number;
  publicConfig: PublicServiceConfigurationV1;
  encryptedSecrets: EncryptedSecretEnvelopeV1;
  runtimeConfig: RuntimeWorkerConfiguration;
}>;

export type RuntimeWorkerConfiguration = Readonly<{
  externalAdapterMode: "mock" | "live";
  workerConcurrency: number;
  maxCanvasRunsPerDay: number;
}>;

export type RuntimeConfigurationApplyStatus = Readonly<{
  appliedVersion: number | null;
  candidateVersion: number | null;
  state: "pending" | "applied" | "error";
  errorCode: string | null;
}>;

function decodeEnvelope(value: unknown): EncryptedSecretEnvelopeV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime configuration envelope is invalid");
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    typeof envelope.nonce !== "string" ||
    typeof envelope.tag !== "string" ||
    typeof envelope.ciphertext !== "string"
  ) {
    throw new Error("runtime configuration envelope is invalid");
  }
  return {
    version: 1,
    nonce: envelope.nonce,
    tag: envelope.tag,
    ciphertext: envelope.ciphertext
  };
}

function decodePublicConfiguration(value: unknown): PublicServiceConfigurationV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime service configuration is invalid");
  }
  const config = value as Record<string, unknown>;
  const path = config.imageGenerationPath;
  if (path !== "headless" && path !== "canvas") {
    throw new Error("runtime service configuration is invalid");
  }
  const stringFields = [
    "imagePlannerBaseUrl", "imagePlannerModel", "imageProviderBaseUrl", "imageProviderModel",
    "canvasBaseUrl", "canvasId", "canvasWorkflowName", "llmBaseUrl", "llmModel",
    "exchangeRateBaseUrl", "miaoshouBaseUrl", "miaoshouAccountId",
    "assetPublishS3Endpoint", "assetPublishS3Region", "assetPublishS3Bucket",
    "assetPublishPublicBaseUrl"
  ] as const;
  if (stringFields.some((field) => typeof config[field] !== "string")) {
    throw new Error("runtime service configuration is invalid");
  }
  return config as PublicServiceConfigurationV1;
}

function decodeRuntimeConfiguration(value: {
  externalAdapterMode: unknown;
  workerConcurrency: unknown;
  maxCanvasRunsPerDay: unknown;
}): RuntimeWorkerConfiguration {
  const workerConcurrency = Number(value.workerConcurrency);
  const maxCanvasRunsPerDay = Number(value.maxCanvasRunsPerDay);
  if (
    (value.externalAdapterMode !== "mock" && value.externalAdapterMode !== "live") ||
    !Number.isInteger(workerConcurrency) || workerConcurrency < 1 || workerConcurrency > 32 ||
    !Number.isInteger(maxCanvasRunsPerDay) || maxCanvasRunsPerDay < 0 || maxCanvasRunsPerDay > 10_000
  ) {
    throw new Error("runtime worker configuration is invalid");
  }
  return {
    externalAdapterMode: value.externalAdapterMode,
    workerConcurrency,
    maxCanvasRunsPerDay
  };
}

export class RuntimeConfigurationRepository {
  constructor(private readonly pool: DbPool) {}

  async seedIfMissing(input: Readonly<{
    publicConfig: PublicServiceConfigurationV1;
    encryptedSecrets: EncryptedSecretEnvelopeV1;
    runtimeConfig: RuntimeWorkerConfiguration;
  }>): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspace_settings
         (id, service_configuration, encrypted_secrets, external_adapter_mode,
          worker_concurrency, max_canvas_runs_per_day)
       VALUES (1, $1::jsonb, $2::jsonb, $3, $4, $5)
       ON CONFLICT (id) DO UPDATE SET
         service_configuration = EXCLUDED.service_configuration,
         encrypted_secrets = EXCLUDED.encrypted_secrets,
         updated_at = now()
       WHERE workspace_settings.encrypted_secrets IS NULL`,
      [
        JSON.stringify(input.publicConfig),
        JSON.stringify(input.encryptedSecrets),
        input.runtimeConfig.externalAdapterMode,
        input.runtimeConfig.workerConcurrency,
        input.runtimeConfig.maxCanvasRunsPerDay
      ]
    );
  }

  async loadCandidate(): Promise<RuntimeConfigurationCandidate | undefined> {
    const result = await this.pool.query<{
      version: string | number;
      service_configuration: unknown;
      encrypted_secrets: unknown;
      external_adapter_mode: unknown;
      worker_concurrency: unknown;
      max_canvas_runs_per_day: unknown;
    }>(
      `SELECT version, service_configuration, encrypted_secrets, external_adapter_mode,
              worker_concurrency, max_canvas_runs_per_day
       FROM workspace_settings
       WHERE id = 1 AND encrypted_secrets IS NOT NULL`
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      version: Number(row.version),
      publicConfig: decodePublicConfiguration(row.service_configuration),
      encryptedSecrets: decodeEnvelope(row.encrypted_secrets),
      runtimeConfig: decodeRuntimeConfiguration({
        externalAdapterMode: row.external_adapter_mode,
        workerConcurrency: row.worker_concurrency,
        maxCanvasRunsPerDay: row.max_canvas_runs_per_day
      })
    };
  }

  async markApplied(version: number): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_configuration_status
         (id, applied_version, candidate_version, state, error_code, updated_at)
       VALUES (1, $1, $1, 'applied', NULL, now())
       ON CONFLICT (id) DO UPDATE SET
         applied_version = EXCLUDED.applied_version,
         candidate_version = EXCLUDED.candidate_version,
         state = EXCLUDED.state,
         error_code = NULL,
         updated_at = now()`,
      [version]
    );
  }

  async markRejected(version: number, errorCode: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_configuration_status
         (id, applied_version, candidate_version, state, error_code, updated_at)
       VALUES (1, NULL, $1, 'error', $2, now())
       ON CONFLICT (id) DO UPDATE SET
         candidate_version = EXCLUDED.candidate_version,
         state = EXCLUDED.state,
         error_code = EXCLUDED.error_code,
         updated_at = now()`,
      [version, errorCode]
    );
  }

  async loadApplyStatus(): Promise<RuntimeConfigurationApplyStatus> {
    const result = await this.pool.query<{
      applied_version: string | number | null;
      candidate_version: string | number | null;
      state: string;
      error_code: string | null;
    }>(
      `SELECT applied_version, candidate_version, state, error_code
       FROM runtime_configuration_status WHERE id = 1`
    );
    const row = result.rows[0];
    if (!row) {
      return { appliedVersion: null, candidateVersion: null, state: "pending", errorCode: null };
    }
    return {
      appliedVersion: row.applied_version === null ? null : Number(row.applied_version),
      candidateVersion: row.candidate_version === null ? null : Number(row.candidate_version),
      state: row.state === "applied" ? "applied" : row.state === "error" ? "error" : "pending",
      errorCode: row.error_code
    };
  }
}
