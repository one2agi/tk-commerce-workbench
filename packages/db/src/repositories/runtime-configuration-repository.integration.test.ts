import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  EncryptedSecretEnvelopeV1,
  PublicServiceConfigurationV1
} from "../../../contracts/src/runtime-configuration.js";

import { bootTestDb, type TestDbHandle } from "../integration/runner.js";
import { INITIAL_SQL } from "../migrations/0000_initial.js";
import { RuntimeConfigurationRepository } from "./runtime-configuration-repository.js";

const PUBLIC_CONFIG: PublicServiceConfigurationV1 = {
  imageGenerationPath: "headless",
  imagePlannerBaseUrl: "https://planner.test/v1",
  imagePlannerModel: "planner-v1",
  imageProviderBaseUrl: "https://images.test/v1",
  imageProviderModel: "image-v1",
  canvasBaseUrl: "",
  canvasId: "canvas-1",
  canvasWorkflowName: "TK工作流",
  llmBaseUrl: "https://llm.test/v1",
  llmModel: "listing-v1",
  exchangeRateBaseUrl: "https://rates.test",
  miaoshouBaseUrl: "https://miaoshou.test",
  miaoshouAccountId: "account-1",
  assetPublishS3Endpoint: "https://s3.test",
  assetPublishS3Region: "auto",
  assetPublishS3Bucket: "assets",
  assetPublishPublicBaseUrl: "https://cdn.test"
};

const ENVELOPE: EncryptedSecretEnvelopeV1 = {
  version: 1,
  nonce: "bm9uY2U=",
  tag: "dGFn",
  ciphertext: "Y2lwaGVydGV4dA=="
};

const RUNTIME_CONFIG = {
  externalAdapterMode: "live" as const,
  workerConcurrency: 4,
  maxCanvasRunsPerDay: 75,
  retryPolicy: { maxAttempts: 5, initialDelaySeconds: 45 }
};

function candidate(version: number, model = `planner-v${version}`) {
  return {
    version,
    publicConfig: { ...PUBLIC_CONFIG, imagePlannerModel: model },
    encryptedSecrets: { ...ENVELOPE, ciphertext: `ciphertext-${version}` },
    runtimeConfig: {
      ...RUNTIME_CONFIG,
      workerConcurrency: Math.min(version, 32),
      retryPolicy: { maxAttempts: Math.min(version, 20), initialDelaySeconds: version * 10 }
    }
  };
}

let handle: TestDbHandle;
let repository: RuntimeConfigurationRepository;

beforeAll(async () => {
  handle = await bootTestDb();
  repository = new RuntimeConfigurationRepository(handle.pool);
});

beforeEach(async () => {
  await handle.reset();
  await handle.migrate(INITIAL_SQL);
});

afterAll(async () => {
  await handle?.close();
});

describe("RuntimeConfigurationRepository", () => {
  it("upgrades an existing status table in place without losing its applied state", async () => {
    await handle.pool.query("DROP TABLE runtime_configuration_status");
    await handle.pool.query(`
      CREATE TABLE runtime_configuration_status (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        applied_version BIGINT,
        candidate_version BIGINT,
        state TEXT NOT NULL DEFAULT 'pending',
        error_code TEXT,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    await handle.pool.query(`
      INSERT INTO runtime_configuration_status
        (id, applied_version, candidate_version, state, error_code)
      VALUES (1, 4, 5, 'error', 'image_provider_required')
    `);

    await handle.migrate(INITIAL_SQL);

    const upgraded = await handle.pool.query<{
      applied_version: string;
      candidate_version: string;
      state: string;
      error_code: string;
      applied_candidate: unknown;
    }>(`
      SELECT applied_version, candidate_version, state, error_code, applied_candidate
      FROM runtime_configuration_status
      WHERE id = 1
    `);
    expect(upgraded.rows).toEqual([{
      applied_version: "4",
      candidate_version: "5",
      state: "error",
      error_code: "image_provider_required",
      applied_candidate: null
    }]);
  });

  it("returns no candidate before the first runtime configuration is seeded", async () => {
    await expect(repository.loadCandidate()).resolves.toBeUndefined();
  });

  it("seeds once and never overwrites the encrypted first-run configuration", async () => {
    await repository.seedIfMissing({
      publicConfig: PUBLIC_CONFIG,
      encryptedSecrets: ENVELOPE,
      runtimeConfig: RUNTIME_CONFIG
    });
    await repository.seedIfMissing({
      publicConfig: { ...PUBLIC_CONFIG, imagePlannerModel: "must-not-replace" },
      encryptedSecrets: { ...ENVELOPE, ciphertext: "b3RoZXI=" },
      runtimeConfig: {
        externalAdapterMode: "mock", workerConcurrency: 1, maxCanvasRunsPerDay: 1,
        retryPolicy: { maxAttempts: 1, initialDelaySeconds: 1 }
      }
    });

    await expect(repository.loadCandidate()).resolves.toEqual({
      version: 1,
      publicConfig: PUBLIC_CONFIG,
      encryptedSecrets: ENVELOPE,
      runtimeConfig: RUNTIME_CONFIG
    });
  });

  it("preserves existing workspace runtime values while adding the first encrypted configuration", async () => {
    await handle.pool.query(
      `INSERT INTO workspace_settings
         (id, external_adapter_mode, worker_concurrency, max_canvas_runs_per_day, retry_policy)
       VALUES (1, 'live', 6, 125, '{"maxAttempts":7,"initialDelaySeconds":90}'::jsonb)`
    );

    await repository.seedIfMissing({
      publicConfig: PUBLIC_CONFIG,
      encryptedSecrets: ENVELOPE,
      runtimeConfig: {
        externalAdapterMode: "mock", workerConcurrency: 2, maxCanvasRunsPerDay: 50,
        retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 }
      }
    });

    await expect(repository.loadCandidate()).resolves.toEqual({
      version: 1,
      publicConfig: PUBLIC_CONFIG,
      encryptedSecrets: ENVELOPE,
      runtimeConfig: {
        externalAdapterMode: "live", workerConcurrency: 6, maxCanvasRunsPerDay: 125,
        retryPolicy: { maxAttempts: 7, initialDelaySeconds: 90 }
      }
    });
  });

  it("records a rejected candidate without replacing the last applied version", async () => {
    await repository.markApplied(candidate(3));
    await repository.markRejected(4, "image_provider_required");

    await expect(repository.loadApplyStatus()).resolves.toEqual({
      appliedVersion: 3,
      candidateVersion: 4,
      state: "error",
      errorCode: "image_provider_required"
    });
  });

  it("clears an old error when a newer version is applied", async () => {
    await repository.markRejected(4, "image_provider_required");
    await repository.markApplied(candidate(5));

    await expect(repository.loadApplyStatus()).resolves.toEqual({
      appliedVersion: 5,
      candidateVersion: 5,
      state: "applied",
      errorCode: null
    });
  });

  it("restores the complete last-known-good candidate after a newer version is rejected", async () => {
    const applied = candidate(5);
    await repository.markApplied(applied);
    await repository.markRejected(6, "image_provider_required");

    await expect(repository.loadAppliedCandidate()).resolves.toEqual(applied);
    await expect(repository.loadApplyStatus()).resolves.toEqual({
      appliedVersion: 5,
      candidateVersion: 6,
      state: "error",
      errorCode: "image_provider_required"
    });
  });

  it("keeps apply status and snapshots monotonic across stale workers", async () => {
    const version5 = candidate(5);
    const version7 = candidate(7);
    await repository.markApplied(version5);
    await repository.markRejected(6, "image_provider_required");
    await repository.markApplied(candidate(4));
    await repository.markRejected(3, "stale_worker_error");

    await expect(repository.loadApplyStatus()).resolves.toEqual({
      appliedVersion: 5,
      candidateVersion: 6,
      state: "error",
      errorCode: "image_provider_required"
    });
    await expect(repository.loadAppliedCandidate()).resolves.toEqual(version5);

    await repository.markApplied(version7);
    await repository.markRejected(6, "stale_worker_error");
    await expect(repository.loadApplyStatus()).resolves.toEqual({
      appliedVersion: 7,
      candidateVersion: 7,
      state: "applied",
      errorCode: null
    });
    await expect(repository.loadAppliedCandidate()).resolves.toEqual(version7);
  });
});
