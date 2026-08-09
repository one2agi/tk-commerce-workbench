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
  retryPolicy: RuntimeRetryPolicy;
}>;

export type RuntimeRetryPolicy = Readonly<{
  maxAttempts: number;
  initialDelaySeconds: number;
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

function decodeRetryPolicy(value: unknown): RuntimeRetryPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime retry policy is invalid");
  }
  const policy = value as Record<string, unknown>;
  const maxAttempts = Number(policy.maxAttempts);
  const initialDelaySeconds = Number(policy.initialDelaySeconds);
  if (
    !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20 ||
    !Number.isInteger(initialDelaySeconds) || initialDelaySeconds < 1 || initialDelaySeconds > 86_400
  ) {
    throw new Error("runtime retry policy is invalid");
  }
  return { maxAttempts, initialDelaySeconds };
}

function decodeRuntimeConfiguration(value: {
  externalAdapterMode: unknown;
  workerConcurrency: unknown;
  maxCanvasRunsPerDay: unknown;
  retryPolicy: unknown;
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
    maxCanvasRunsPerDay,
    retryPolicy: decodeRetryPolicy(value.retryPolicy)
  };
}

function decodeCandidate(value: unknown): RuntimeConfigurationCandidate {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runtime applied configuration is invalid");
  }
  const candidate = value as Record<string, unknown>;
  const version = Number(candidate.version);
  const runtime = candidate.runtimeConfig;
  if (!Number.isSafeInteger(version) || version < 0 || !runtime || typeof runtime !== "object" || Array.isArray(runtime)) {
    throw new Error("runtime applied configuration is invalid");
  }
  const runtimeConfig = runtime as Record<string, unknown>;
  return {
    version,
    publicConfig: decodePublicConfiguration(candidate.publicConfig),
    encryptedSecrets: decodeEnvelope(candidate.encryptedSecrets),
    runtimeConfig: decodeRuntimeConfiguration({
      externalAdapterMode: runtimeConfig.externalAdapterMode,
      workerConcurrency: runtimeConfig.workerConcurrency,
      maxCanvasRunsPerDay: runtimeConfig.maxCanvasRunsPerDay,
      retryPolicy: runtimeConfig.retryPolicy
    })
  };
}

function safeRejectionCode(value: string): string {
  return /^[a-z][a-z0-9_]{0,63}$/.test(value)
    ? value
    : "runtime_configuration_invalid";
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
          worker_concurrency, max_canvas_runs_per_day, retry_policy)
       VALUES (1, $1::jsonb, $2::jsonb, $3, $4, $5, $6::jsonb)
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
        input.runtimeConfig.maxCanvasRunsPerDay,
        JSON.stringify(input.runtimeConfig.retryPolicy)
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
      retry_policy: unknown;
    }>(
      `SELECT version, service_configuration, encrypted_secrets, external_adapter_mode,
              worker_concurrency, max_canvas_runs_per_day, retry_policy
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
        maxCanvasRunsPerDay: row.max_canvas_runs_per_day,
        retryPolicy: row.retry_policy
      })
    };
  }

  async loadAppliedCandidate(): Promise<RuntimeConfigurationCandidate | undefined> {
    const result = await this.pool.query<{
      applied_version: string | number | null;
      applied_candidate: unknown;
    }>(
      `SELECT applied_version, applied_candidate
       FROM runtime_configuration_status WHERE id = 1`
    );
    const row = result.rows[0];
    if (!row || row.applied_version === null) return undefined;
    if (row.applied_candidate) return decodeCandidate(row.applied_candidate);

    const current = await this.loadCandidate();
    return current?.version === Number(row.applied_version) ? current : undefined;
  }

  async markApplied(candidate: RuntimeConfigurationCandidate): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_configuration_status
         (id, applied_version, candidate_version, state, error_code, updated_at, applied_candidate)
       VALUES (1, $1, $1, 'applied', NULL, now(), $2::jsonb)
       ON CONFLICT (id) DO UPDATE SET
         applied_version = CASE
           WHEN runtime_configuration_status.applied_version IS NULL
             OR EXCLUDED.applied_version > runtime_configuration_status.applied_version
           THEN EXCLUDED.applied_version ELSE runtime_configuration_status.applied_version END,
         candidate_version = CASE
           WHEN runtime_configuration_status.candidate_version IS NULL
             OR EXCLUDED.candidate_version > runtime_configuration_status.candidate_version
           THEN EXCLUDED.candidate_version ELSE runtime_configuration_status.candidate_version END,
         state = CASE
           WHEN runtime_configuration_status.candidate_version IS NULL
             OR EXCLUDED.candidate_version >= runtime_configuration_status.candidate_version
           THEN 'applied' ELSE runtime_configuration_status.state END,
         error_code = CASE
           WHEN runtime_configuration_status.candidate_version IS NULL
             OR EXCLUDED.candidate_version >= runtime_configuration_status.candidate_version
           THEN NULL ELSE runtime_configuration_status.error_code END,
         applied_candidate = CASE
           WHEN runtime_configuration_status.applied_version IS NULL
             OR EXCLUDED.applied_version >= runtime_configuration_status.applied_version
           THEN EXCLUDED.applied_candidate ELSE runtime_configuration_status.applied_candidate END,
         updated_at = now()`,
      [candidate.version, JSON.stringify(candidate)]
    );
  }

  async markRejected(version: number, errorCode: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO runtime_configuration_status
         (id, applied_version, candidate_version, state, error_code, updated_at)
       VALUES (1, NULL, $1, 'error', $2, now())
       ON CONFLICT (id) DO UPDATE SET
         candidate_version = CASE
           WHEN runtime_configuration_status.candidate_version IS NULL
             OR EXCLUDED.candidate_version > runtime_configuration_status.candidate_version
           THEN EXCLUDED.candidate_version ELSE runtime_configuration_status.candidate_version END,
         state = CASE
           WHEN runtime_configuration_status.candidate_version IS NULL
             OR EXCLUDED.candidate_version > runtime_configuration_status.candidate_version
             OR (EXCLUDED.candidate_version = runtime_configuration_status.candidate_version
                 AND runtime_configuration_status.state <> 'applied')
           THEN 'error' ELSE runtime_configuration_status.state END,
         error_code = CASE
           WHEN runtime_configuration_status.candidate_version IS NULL
             OR EXCLUDED.candidate_version > runtime_configuration_status.candidate_version
             OR (EXCLUDED.candidate_version = runtime_configuration_status.candidate_version
                 AND runtime_configuration_status.state <> 'applied')
           THEN EXCLUDED.error_code ELSE runtime_configuration_status.error_code END,
         updated_at = now()`,
      [version, safeRejectionCode(errorCode)]
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
