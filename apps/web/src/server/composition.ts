import { randomUUID } from "node:crypto";

import { loadConfig } from "../../../../packages/config/src/env.js";
import pg from "pg";

import { AutomationRunRepository } from "../../../../packages/db/src/repositories/automation-run-repository.js";
import { JobRepository } from "../../../../packages/db/src/repositories/job-repository.js";
import type { DbPool } from "../../../../packages/db/src/schema/index.js";

import { createExtensionTokenVerifier, type ExtensionTokenVerifier } from "./auth/extension-token";
import { AutomationService } from "./services/automation-service";
import { IngestService } from "./services/ingest-service";
import { ProductService, type QueryPort } from "./services/product-service";
import { SettingsService } from "./services/settings-service";
import { TaskService, type TaskAction, type TaskActionUnitOfWork } from "./services/task-service";
import { TemplateService } from "./services/template-service";

export interface ServerServices {
  verifyExtensionToken: ExtensionTokenVerifier;
  ingest: IngestService;
  automation: AutomationService;
  products: ProductService;
  tasks: TaskService;
  templates: TemplateService;
  settings: SettingsService;
}

interface RuntimeConfig {
  extensionToken: string;
  externalAdapterMode: "mock" | "live";
  assetRoot: string;
  workerConcurrency: number;
  maxCanvasRunsPerDay: number;
  miaoshouConfigured: boolean;
  canvasConfigured: boolean;
  llmConfigured: boolean;
  exchangeRateConfigured: boolean;
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig & { databaseUrl: string } {
  const config = loadConfig(env);
  return {
    databaseUrl: config.databaseUrl,
    extensionToken: config.extensionToken,
    externalAdapterMode: config.externalAdapterMode,
    assetRoot: config.assetRoot,
    workerConcurrency: config.workerConcurrency,
    maxCanvasRunsPerDay: config.maxCanvasRunsPerDay,
    miaoshouConfigured: config.miaoshouConfigured,
    canvasConfigured: config.canvasConfigured,
    llmConfigured: config.llmConfigured,
    exchangeRateConfigured: config.exchangeRateConfigured
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

class PgTaskActions implements TaskActionUnitOfWork {
  constructor(private readonly pool: DbPool) {}

  async execute<T>(command: Parameters<TaskActionUnitOfWork["execute"]>[0]): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const value = await command({
        tasks: {
          act: async (taskId, action) => {
            const result = await client.query(taskActionSql(action), [taskId]);
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
      return `UPDATE jobs SET status = 'paused', updated_at = now()
              WHERE id = $1 AND status = 'queued'`;
    case "resume":
      return `UPDATE jobs SET status = 'queued', updated_at = now()
              WHERE id = $1 AND status = 'paused'`;
    case "retry":
      return `UPDATE jobs SET status = 'queued', error = NULL, next_attempt_at = NULL,
                updated_at = now()
              WHERE id = $1 AND status = 'failed' AND attempt < max_attempts`;
    case "cancel":
      return `UPDATE jobs SET status = 'failed', owner = NULL, lease_token = NULL,
                lease_expires_at = NULL,
                error = '{"kind":"fatal","code":"cancelled","safeMessage":"Cancelled by operator"}'::jsonb,
                updated_at = now()
              WHERE id = $1 AND status IN ('queued', 'paused')`;
  }
}

export function createServerServices(input: {
  pool: DbPool;
  config: RuntimeConfig;
}): ServerServices {
  const database = queryPort(input.pool);
  const jobs = new JobRepository(input.pool);
  const automationRuns = new AutomationRunRepository(input.pool);
  const secretStatus = {
    miaoshouConfigured: input.config.miaoshouConfigured,
    canvasConfigured: input.config.canvasConfigured,
    llmConfigured: input.config.llmConfigured,
    exchangeRateConfigured: input.config.exchangeRateConfigured
  };
  return {
    verifyExtensionToken: createExtensionTokenVerifier(input.config.extensionToken),
    ingest: new IngestService(jobs),
    automation: new AutomationService(new RevisionVersions(input.pool), automationRuns),
    products: new ProductService(database),
    tasks: new TaskService(database, new PgTaskActions(input.pool)),
    templates: new TemplateService(database),
    settings: new SettingsService({
      defaultLocale: "th-TH",
      defaultCurrency: "THB",
      externalAdapterMode: input.config.externalAdapterMode,
      secretStatus,
      workerConcurrency: input.config.workerConcurrency,
      maxCanvasRunsPerDay: input.config.maxCanvasRunsPerDay,
      assetRoot: input.config.assetRoot
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
