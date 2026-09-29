import { randomUUID } from "node:crypto";

import { loadConfig, type AppConfig } from "../../../../packages/config/src/env.js";
import { createRuntimeSecretCodec } from "../../../../packages/config/src/runtime-secrets.js";
import type { PublicServiceConfigurationV1, RuntimeSecretsV1 } from "../../../../packages/contracts/src/runtime-configuration.js";
import pg from "pg";

import { AutomationRunRepository } from "../../../../packages/db/src/repositories/automation-run-repository.js";
import { JobRepository } from "../../../../packages/db/src/repositories/job-repository.js";
import { LocalCaptureRepository } from "../../../../packages/db/src/repositories/local-capture-repository.js";
import { ApprovalRepository, CatalogRepository, schema } from "@tk/db";
import { ImageGenerationRepository } from "../../../../packages/db/src/repositories/image-generation-repository.js";
import { AuditRepository } from "../../../../packages/db/src/repositories/audit-repository.js";
import { RuntimeConfigurationRepository } from "../../../../packages/db/src/repositories/runtime-configuration-repository.js";
import type { DbPool } from "../../../../packages/db/src/schema/index.js";

import { createDynamicExtensionTokenVerifier, type ExtensionTokenVerifier } from "./auth/extension-token";
import { AutomationService } from "./services/automation-service";
import { IngestService } from "./services/ingest-service";
import { ProductService, type QueryPort } from "./services/product-service";
import { PgSettingsStore, SettingsService } from "./services/settings-service";
import { MiaoshouSyncService } from "./services/miaoshou-sync-service";
import { ProductRerunService } from "./services/product-rerun-service";
import { createPgRerunPort } from "../app/api/v1/products/[productId]/rerun/route";
import { createPgApprovalInvalidationPort } from "./services/approval-invalidation";
import { TaskService, type TaskAction, type TaskActionUnitOfWork } from "./services/task-service";
import { PgTemplateStore, TemplateService } from "./services/template-service";
import {
  ImageGenerationTemplateService,
  type ImageGenerationTemplateStore,
  type ImageGenerationTemplate,
  type ImageGenerationTemplateVersion
} from "./services/image-generation-template-service";
import { ImageGenerationService } from "./services/image-generation-service";
import {
  createImagePromptPlannerLoader,
  type ImagePromptPlannerLoader
} from "./image-prompt-test-runtime";
import type { LoadPromptTestContextResult } from "../../../../packages/db/src/repositories/image-generation-repository.js";

export interface ServerServices {
  verifyExtensionToken: ExtensionTokenVerifier;
  ingest: IngestService;
  automation: AutomationService;
  products: ProductService;
  tasks: TaskService;
  templates: TemplateService;
  settings: SettingsService;
  approvals: ApprovalRepository;
  syncs: MiaoshouSyncService;
  productReruns: ProductRerunService;
  imageGenerationTemplates: ImageGenerationTemplateService;
  imageGeneration: ImageGenerationService;
  loadImagePromptPlanner: ImagePromptPlannerLoader;
  loadImagePromptTestContext(productId: string): Promise<LoadPromptTestContextResult | null>;
  recordImagePromptTestAudit(event: {
    type: string;
    templateId: string;
    productId: string;
    outputCount: number;
    promptsCount: number;
  }): Promise<void>;
}

interface RuntimeConfig {
  bootstrapConfig?: AppConfig;
  extensionToken: string;
  externalAdapterMode: "mock" | "live";
  assetRoot: string;
  workerConcurrency: number;
  maxCanvasRunsPerDay: number;
  miaoshouConfigured: boolean;
  canvasConfigured: boolean;
  llmConfigured: boolean;
  exchangeRateConfigured: boolean;
  imageGenerationPath?: "headless" | "canvas";
  imagePlannerModel?: string;
  imageProviderModel?: string;
  imageGenerationConfigured?: boolean;
  canvasWorkflow?: string;
  configEncryptionKey?: string;
  serviceConfiguration?: PublicServiceConfigurationV1;
  initialSecrets?: RuntimeSecretsV1;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig & { databaseUrl: string } {
  const config = loadConfig(env);
  const serviceConfiguration: PublicServiceConfigurationV1 = {
    imageGenerationPath: config.imageGenerationPath,
    imagePlannerBaseUrl: config.imagePlannerBaseUrl,
    imagePlannerModel: config.imagePlannerModel,
    imageProviderBaseUrl: config.imageProviderBaseUrl,
    imageProviderModel: config.imageProviderModel,
    canvasBaseUrl: config.canvasBaseUrl,
    canvasId: config.canvasId,
    canvasWorkflowName: config.canvasWorkflowName,
    llmBaseUrl: config.llmBaseUrl,
    llmModel: config.llmModel,
    exchangeRateBaseUrl: config.exchangeRateBaseUrl,
    miaoshouBaseUrl: env.MIAOSHOU_BASE_URL?.trim() ?? "",
    miaoshouAccountId: env.MIAOSHOU_ACCOUNT_ID?.trim() ?? "",
    assetPublishS3Endpoint: config.assetPublishS3Endpoint,
    assetPublishS3Region: config.assetPublishS3Region,
    assetPublishS3Bucket: config.assetPublishS3Bucket,
    assetPublishPublicBaseUrl: config.assetPublishPublicBaseUrl
  };
  const initialSecrets: RuntimeSecretsV1 = Object.fromEntries(Object.entries({
    imagePlannerApiKey: config.imagePlannerApiKey,
    imageProviderApiKey: config.imageProviderApiKey,
    canvasApiKey: config.canvasApiKey,
    llmApiKey: config.llmApiKey,
    miaoshouAppKey: env.MIAOSHOU_APP_KEY?.trim() ?? "",
    miaoshouAppSecret: env.MIAOSHOU_APP_SECRET?.trim() ?? "",
    miaoshouAuthorization: env.MIAOSHOU_AUTHORIZATION?.trim() ?? "",
    miaoshouCookie: env.MIAOSHOU_COOKIE?.trim() ?? "",
    assetPublishS3AccessKeyId: config.assetPublishS3AccessKeyId,
    assetPublishS3SecretAccessKey: config.assetPublishS3SecretAccessKey,
    extensionToken: config.extensionToken
  }).filter(([, value]) => value)) as RuntimeSecretsV1;
  return {
    bootstrapConfig: config,
    databaseUrl: config.databaseUrl,
    extensionToken: config.extensionToken,
    externalAdapterMode: config.externalAdapterMode,
    assetRoot: config.assetRoot,
    workerConcurrency: config.workerConcurrency,
    maxCanvasRunsPerDay: config.maxCanvasRunsPerDay,
    miaoshouConfigured: config.miaoshouConfigured,
    canvasConfigured: config.canvasConfigured,
    llmConfigured: config.llmConfigured,
    exchangeRateConfigured: config.exchangeRateConfigured,
    imageGenerationPath: config.imageGenerationPath,
    imagePlannerModel: config.imagePlannerModel,
    imageProviderModel: config.imageProviderModel,
    imageGenerationConfigured: config.imageGenerationConfigured,
    canvasWorkflow: config.canvasWorkflowName,
    configEncryptionKey: config.configEncryptionKey,
    serviceConfiguration,
    initialSecrets
  };
}

function queryPort(pool: DbPool): QueryPort {
  return {
    async query(text, values) {
      const result = await pool.query(text, values ? [...values] : undefined);
      return { rows: result.rows as Array<Record<string, unknown>> };
    }
  };
}

class RevisionVersions {
  constructor(private readonly pool: DbPool) {}

  async processingVersion(revisionId: string): Promise<number> {
    const result = await this.pool.query<{ draft_version: number }>(
      "SELECT draft_version FROM product_revisions WHERE id = $1",
      [revisionId]
    );
    const row = result.rows[0];
    if (!row) throw new Error("revision_not_found");
    return Number(row.draft_version);
  }
}

class PgImageGenerationTemplateStore implements ImageGenerationTemplateStore {
  constructor(private readonly pool: DbPool) {}

  async createTemplate(input: {
    name: string;
    categoryKey: string;
    parentCategoryKey?: string;
  }): Promise<ImageGenerationTemplate> {
    const id = `tmpl_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    await this.pool.query(
      `INSERT INTO ${schema.imageGenerationTemplates}
        (id, name, category_key, parent_category_key, enabled, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $5)`,
      [id, input.name, input.categoryKey, input.parentCategoryKey ?? null, now]
    );
    return {
      id,
      name: input.name,
      categoryKey: input.categoryKey,
      parentCategoryKey: input.parentCategoryKey ?? null,
      activeVersionId: null,
      enabled: true,
      archivedAt: null,
      createdAt: now,
      updatedAt: now
    };
  }

  async createVersion(input: {
    templateId: string;
    version: number;
    lifecycleState: "draft" | "active" | "archived";
    recipe: import("./services/image-generation-template-service").ValidatedRecipe;
    activatedAt?: Date;
  }): Promise<ImageGenerationTemplateVersion> {
    const id = `ver_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const now = new Date();
    await this.pool.query(
      `INSERT INTO ${schema.imageGenerationTemplateVersions}
        (id, template_id, version, lifecycle_state, recipe, activated_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        id,
        input.templateId,
        input.version,
        input.lifecycleState,
        JSON.stringify(input.recipe),
        input.activatedAt ?? null,
        now
      ]
    );
    return {
      id,
      templateId: input.templateId,
      version: input.version,
      lifecycleState: input.lifecycleState,
      recipe: input.recipe,
      activatedAt: input.activatedAt ?? null,
      createdAt: now
    };
  }

  async getVersionsByTemplate(templateId: string): Promise<ImageGenerationTemplateVersion[]> {
    const result = await this.pool.query(
      `SELECT id, template_id, version, lifecycle_state, recipe, activated_at, created_at
       FROM ${schema.imageGenerationTemplateVersions}
       WHERE template_id = $1 ORDER BY version DESC`,
      [templateId]
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      templateId: String(row.template_id),
      version: Number(row.version),
      lifecycleState: row.lifecycle_state as "draft" | "active" | "archived",
      recipe: row.recipe,
      activatedAt: row.activated_at ? new Date(row.activated_at) : null,
      createdAt: new Date(row.created_at)
    }));
  }

  async getVersion(versionId: string): Promise<ImageGenerationTemplateVersion | null> {
    const result = await this.pool.query(
      `SELECT id, template_id, version, lifecycle_state, recipe, activated_at, created_at
       FROM ${schema.imageGenerationTemplateVersions} WHERE id = $1`,
      [versionId]
    );
    if (!result.rowCount || result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      id: String(row.id),
      templateId: String(row.template_id),
      version: Number(row.version),
      lifecycleState: row.lifecycle_state as "draft" | "active" | "archived",
      recipe: row.recipe,
      activatedAt: row.activated_at ? new Date(row.activated_at) : null,
      createdAt: new Date(row.created_at)
    };
  }

  async getTemplate(templateId: string): Promise<ImageGenerationTemplate | null> {
    const result = await this.pool.query(
      `SELECT id, name, category_key, parent_category_key, active_version_id, enabled, archived_at, created_at, updated_at
       FROM ${schema.imageGenerationTemplates} WHERE id = $1`,
      [templateId]
    );
    if (!result.rowCount || result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      categoryKey: String(row.category_key),
      parentCategoryKey: row.parent_category_key ? String(row.parent_category_key) : null,
      activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
      enabled: row.enabled === true,
      archivedAt: row.archived_at ? new Date(row.archived_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async getTemplateByCategoryKey(categoryKey: string): Promise<ImageGenerationTemplate | null> {
    const result = await this.pool.query(
      `SELECT id, name, category_key, parent_category_key, active_version_id, enabled, archived_at, created_at, updated_at
       FROM ${schema.imageGenerationTemplates}
       WHERE category_key = $1 AND archived_at IS NULL`,
      [categoryKey]
    );
    if (!result.rowCount || result.rowCount === 0) return null;
    const row = result.rows[0];
    return {
      id: String(row.id),
      name: String(row.name),
      categoryKey: String(row.category_key),
      parentCategoryKey: row.parent_category_key ? String(row.parent_category_key) : null,
      activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
      enabled: row.enabled === true,
      archivedAt: row.archived_at ? new Date(row.archived_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    };
  }

  async updateVersionArchived(version: ImageGenerationTemplateVersion): Promise<void> {
    await this.pool.query(
      `UPDATE ${schema.imageGenerationTemplateVersions} SET lifecycle_state = 'archived' WHERE id = $1`,
      [version.id]
    );
  }

  async activateVersion(templateId: string, versionId: string): Promise<ImageGenerationTemplateVersion> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        `UPDATE ${schema.imageGenerationTemplateVersions}
         SET lifecycle_state = 'archived'
         WHERE template_id = $1 AND lifecycle_state = 'active' AND id <> $2`,
        [templateId, versionId]
      );
      const activated = await client.query(
        `UPDATE ${schema.imageGenerationTemplateVersions}
         SET lifecycle_state = 'active', activated_at = now()
         WHERE id = $1 AND template_id = $2 AND lifecycle_state = 'draft'
         RETURNING id, template_id, version, lifecycle_state, recipe, activated_at, created_at`,
        [versionId, templateId]
      );
      const row = activated.rows[0];
      if (!row) throw new Error("draft_version_not_found");
      await client.query(
        `UPDATE ${schema.imageGenerationTemplates}
         SET active_version_id = $1, updated_at = now() WHERE id = $2`,
        [versionId, templateId]
      );
      await client.query("COMMIT");
      return {
        id: String(row.id),
        templateId: String(row.template_id),
        version: Number(row.version),
        lifecycleState: "active",
        recipe: row.recipe,
        activatedAt: new Date(row.activated_at),
        createdAt: new Date(row.created_at)
      };
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async updateTemplateActiveVersion(templateId: string, versionId: string): Promise<void> {
    await this.pool.query(
      `UPDATE ${schema.imageGenerationTemplates}
       SET active_version_id = $1, updated_at = now() WHERE id = $2`,
      [versionId, templateId]
    );
  }

  async listTemplates(): Promise<ImageGenerationTemplate[]> {
    const result = await this.pool.query(
      `SELECT id, name, category_key, parent_category_key, active_version_id, enabled, archived_at, created_at, updated_at
       FROM ${schema.imageGenerationTemplates} ORDER BY created_at DESC`
    );
    return result.rows.map((row) => ({
      id: String(row.id),
      name: String(row.name),
      categoryKey: String(row.category_key),
      parentCategoryKey: row.parent_category_key ? String(row.parent_category_key) : null,
      activeVersionId: row.active_version_id ? String(row.active_version_id) : null,
      enabled: row.enabled === true,
      archivedAt: row.archived_at ? new Date(row.archived_at) : null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at)
    }));
  }

  async resolveActiveByCategory(categoryKey: string): Promise<{
    template: ImageGenerationTemplate;
    version: ImageGenerationTemplateVersion;
  } | null> {
    // Try exact match, then parent fallbacks
    const candidates = await this.pool.query(
      `SELECT id, name, category_key, parent_category_key, active_version_id, enabled, archived_at, created_at, updated_at
       FROM ${schema.imageGenerationTemplates}
       WHERE (category_key = $1 OR category_key = $2 OR $1 LIKE category_key || '.%')
         AND archived_at IS NULL
       ORDER BY LENGTH(category_key) DESC, created_at ASC`,
      [categoryKey, categoryKey.split(".").slice(0, -1).join(".")]
    );
    if (!candidates.rowCount || candidates.rowCount === 0) return null;

    for (const row of candidates.rows) {
      if (!row.active_version_id) continue;
      const ver = await this.getVersion(String(row.active_version_id));
      if (ver && ver.lifecycleState === "active") {
        return {
          template: {
            id: String(row.id),
            name: String(row.name),
            categoryKey: String(row.category_key),
            parentCategoryKey: row.parent_category_key ? String(row.parent_category_key) : null,
            activeVersionId: String(row.active_version_id),
            enabled: row.enabled === true,
            archivedAt: row.archived_at ? new Date(row.archived_at) : null,
            createdAt: new Date(row.created_at),
            updatedAt: new Date(row.updated_at)
          },
          version: ver
        };
      }
    }
    return null;
  }
}

class PgTaskActions implements TaskActionUnitOfWork {
  constructor(private readonly pool: DbPool) {}

  async execute<T>(command: Parameters<TaskActionUnitOfWork["execute"]>[0]): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await command({
        tasks: {
          act: async (taskId, action, reason) => {
            const values = action === "pause"
              ? [taskId, reason ?? "Paused by operator"]
              : [taskId];
            const result = await client.query(taskActionSql(action), values);
            return result.rowCount === 1;
          }
        },
        audit: {
          append: async (event) => {
            const id = `audit_${randomUUID()}`;
            await client.query(
              `INSERT INTO audit_events
               (id, actor_type, action, target_kind, target_id, payload, redacted)
               VALUES ($1, $2, $3, $4, $5, $6::jsonb, true)`,
              [id, event.actorType, event.action, event.targetKind, event.targetId,
                JSON.stringify(event.payload ?? {})]
            );
            return id;
          }
        }
      });
      await client.query("COMMIT");
      return value as T;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }
}

function taskActionSql(action: TaskAction): string {
  switch (action) {
    case "pause":
      // Never break a running worker's fenced lease from the Web process. A
      // queued task can be paused before it is claimed; running work must reach
      // a worker-owned safe point or expire through repository reconciliation.
      return `UPDATE jobs SET status = 'paused', pause_reason = $2, updated_at = now()
              WHERE id = $1 AND status = 'queued'`;
    case "resume":
      return `UPDATE jobs SET status = 'queued', pause_reason = NULL, updated_at = now()
              WHERE id = $1 AND status = 'paused'`;
    case "retry":
      return `UPDATE jobs SET status = 'queued', error = NULL, next_attempt_at = NULL,
                pause_reason = NULL, updated_at = now()
              WHERE id = $1 AND status IN ('failed', 'needs_input')
                AND (
                  remote_task_id IS NULL
                  OR (
                    kind = 'canvas_generate'
                    AND COALESCE(error->>'code', '') IN ('reconcile_failed', 'canvas_zero_valid_outputs')
                  )
                )
                AND COALESCE(error->>'code', '') <> 'reconcile_required'
                AND attempt < max_attempts`;
    case "cancel":
      return `UPDATE jobs SET status = 'failed', owner = NULL, lease_token = NULL,
                lease_expires_at = NULL, pause_reason = NULL,
                error = '{"kind":"fatal","code":"cancelled","safeMessage":"Cancelled by operator"}'::jsonb,
                updated_at = now()
              WHERE id = $1 AND status IN ('queued', 'paused')`;
  }
}

export function createServerServices(input: {
  pool: DbPool;
  config: RuntimeConfig;
}): ServerServices {
  const imageGenerationPath = input.config.imageGenerationPath ?? "canvas";
  const imagePlannerModel = input.config.imagePlannerModel ?? "";
  const imageProviderModel = input.config.imageProviderModel ?? "";
  const canvasWorkflow = input.config.canvasWorkflow ?? "TK工作流";
  const database = queryPort(input.pool);
  const jobs = new JobRepository(input.pool);
  const automationRuns = new AutomationRunRepository(input.pool);
  const catalog = new CatalogRepository(input.pool);
  const runtimeConfiguration = new RuntimeConfigurationRepository(input.pool);
  const imageGenerationRepository = new ImageGenerationRepository(input.pool);
  const audit = new AuditRepository(input.pool);
  const secretCodec = input.config.configEncryptionKey
    ? createRuntimeSecretCodec(input.config.configEncryptionKey)
    : undefined;
  const encryptedSecrets = secretCodec
    ? secretCodec.seal(input.config.initialSecrets ?? {}, "workspace_settings:1")
    : null;
  const loadExtensionToken = async (): Promise<string> => {
    if (!secretCodec) return input.config.extensionToken;
    const candidate = await runtimeConfiguration.loadCandidate();
    if (!candidate) return input.config.extensionToken;
    return secretCodec.open(candidate.encryptedSecrets, "workspace_settings:1").extensionToken ?? "";
  };
  const products = new ProductService(catalog);
  const loadImagePromptPlanner = createImagePromptPlannerLoader({
    bootstrapConfig: () => input.config.bootstrapConfig ?? loadConfig(),
    loadAppliedCandidate: () => runtimeConfiguration.loadAppliedCandidate(),
    openSecrets: secretCodec
      ? (candidate) => secretCodec.open(candidate.encryptedSecrets, "workspace_settings:1")
      : undefined
  });
  const reruns = createPgRerunPort(
    createPgApprovalInvalidationPort(() => input.pool),
    () => input.pool
  );
  const secretStatus = {
    miaoshouConfigured: input.config.miaoshouConfigured,
    canvasConfigured: input.config.canvasConfigured,
    llmConfigured: input.config.llmConfigured,
    exchangeRateConfigured: input.config.exchangeRateConfigured,
    imageGenerationConfigured: input.config.imageGenerationConfigured ?? false,
    imageGenerationPath
  };
  const settingsStore = new PgSettingsStore(input.pool);
  const settingsDefaults = {
    defaultLocale: "th-TH",
    defaultCurrency: "THB",
    externalAdapterMode: input.config.externalAdapterMode,
    workerConcurrency: input.config.workerConcurrency,
    maxCanvasRunsPerDay: input.config.maxCanvasRunsPerDay,
    assetRoot: input.config.assetRoot,
    pricingDefaults: {
      domesticShippingCny: "2.00",
      crossBorderCostCny: "6.00",
      fixedTargetCostThb: "10.00",
      platformFeeRate: "0.05",
      paymentFeeRate: "0.03",
      targetProfitRate: "0.30",
      ending: "9"
    },
    providerOptions: {
      listingProvider: "rules",
      listingModel: "rules-v1",
      canvasWorkflow,
      imageGenerationPath,
      imagePlannerModel,
      imageProviderModel
    },
    retryPolicy: { maxAttempts: 3, initialDelaySeconds: 30 },
    serviceConfiguration: input.config.serviceConfiguration,
    encryptedSecrets
  } as const;
  return {
    verifyExtensionToken: createDynamicExtensionTokenVerifier(loadExtensionToken),
    ingest: new IngestService(
      jobs,
      new LocalCaptureRepository(input.pool),
      async () => (await settingsStore.get())?.retryPolicy ?? settingsDefaults.retryPolicy
    ),
    automation: new AutomationService(new RevisionVersions(input.pool), automationRuns),
    products,
    tasks: new TaskService(database, new PgTaskActions(input.pool)),
    templates: new TemplateService(new PgTemplateStore(input.pool)),
    settings: new SettingsService(settingsStore, {
      defaults: settingsDefaults,
      secretStatus,
      secretCodec,
      loadApplyStatus: () => runtimeConfiguration.loadApplyStatus(),
      activeRuntime: {
        externalAdapterMode: input.config.externalAdapterMode,
        workerConcurrency: input.config.workerConcurrency,
        maxCanvasRunsPerDay: input.config.maxCanvasRunsPerDay,
        assetRoot: input.config.assetRoot,
        imageGenerationPath,
        imagePlannerModel,
        imageProviderModel,
        canvasWorkflow,
        imageGenerationConfigured: input.config.imageGenerationConfigured ?? false
      }
    }),
    approvals: new ApprovalRepository(input.pool),
    syncs: new MiaoshouSyncService(database),
    productReruns: new ProductRerunService(products, reruns),
    imageGenerationTemplates: new ImageGenerationTemplateService(new PgImageGenerationTemplateStore(input.pool)),
    loadImagePromptPlanner,
    loadImagePromptTestContext: (productId) => imageGenerationRepository.loadPromptTestContext(productId),
    recordImagePromptTestAudit: async (event) => {
      await audit.append({
        actorType: "operator",
        action: "image_template.prompt_test",
        targetKind: "image_generation_template",
        targetId: event.templateId,
        payload: {
          productId: event.productId,
          outputCount: event.outputCount,
          promptsCount: event.promptsCount
        }
      });
    },
    imageGeneration: new ImageGenerationService({
      imageGenerationRepository,
      imageGenerationTemplates: new PgImageGenerationTemplateStore(input.pool)
    })
  };
}

let singleton: ServerServices | undefined;

export async function getServerServices(): Promise<ServerServices> {
  if (singleton) return singleton;
  const config = loadRuntimeConfig();
  const pool = new pg.Pool({ connectionString: config.databaseUrl });
  singleton = createServerServices({ pool, config });
  return singleton;
}
