import type { WorkspaceSettingsViewV1 } from "@tk/contracts/read-models";
import type { DbPool } from "../../../../../packages/db/src/schema/index.js";

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
}>;

export type WorkspaceSettingsView = WorkspaceSettingsRecord & Pick<WorkspaceSettingsViewV1, "secretStatus"> & Readonly<{
  applicationNote: string;
}>;

export type SettingsUpdate = Readonly<Partial<Omit<WorkspaceSettingsRecord, "version">> & {
  expectedVersion: number;
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

type RuntimeSettings = Readonly<{
  defaults: Omit<WorkspaceSettingsRecord, "version">;
  secretStatus: WorkspaceSettingsViewV1["secretStatus"];
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
    const current = await this.get();
    const next: Omit<WorkspaceSettingsRecord, "version"> = {
      defaultLocale: command.defaultLocale ?? current.defaultLocale,
      defaultCurrency: command.defaultCurrency ?? current.defaultCurrency,
      externalAdapterMode: command.externalAdapterMode ?? current.externalAdapterMode,
      workerConcurrency: command.workerConcurrency ?? current.workerConcurrency,
      maxCanvasRunsPerDay: command.maxCanvasRunsPerDay ?? current.maxCanvasRunsPerDay,
      assetRoot: command.assetRoot ?? current.assetRoot,
      pricingDefaults: command.pricingDefaults ?? current.pricingDefaults,
      providerOptions: command.providerOptions ?? current.providerOptions,
      retryPolicy: command.retryPolicy ?? current.retryPolicy
    };
    const updated = await this.store.update(command.expectedVersion, next);
    if (!updated) {
      const actual = await this.store.get();
      throw new SettingsConflictError(actual?.version ?? current.version);
    }
    return this.toView(updated);
  }

  private toView(record: WorkspaceSettingsRecord): WorkspaceSettingsView {
    return {
      ...record,
      pricingDefaults: { ...record.pricingDefaults },
      providerOptions: { ...record.providerOptions },
      retryPolicy: { ...record.retryPolicy },
      secretStatus: { ...this.runtime.secretStatus },
      applicationNote: "这些值保存为工作区默认值；已启动的 Worker 进程不会被浏览器动态重配。"
    };
  }
}

export class PgSettingsStore implements SettingsStore {
  constructor(private readonly pool: DbPool) {}

  async initialize(defaults: WorkspaceSettingsRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO workspace_settings
        (id, default_locale, default_currency, external_adapter_mode, worker_concurrency,
         max_canvas_runs_per_day, asset_root, pricing_defaults, provider_options, retry_policy, version)
       VALUES (1, $1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10)
       ON CONFLICT (id) DO NOTHING`,
      [defaults.defaultLocale, defaults.defaultCurrency, defaults.externalAdapterMode,
        defaults.workerConcurrency, defaults.maxCanvasRunsPerDay, defaults.assetRoot,
        JSON.stringify(defaults.pricingDefaults), JSON.stringify(defaults.providerOptions),
        JSON.stringify(defaults.retryPolicy), defaults.version]
    );
  }

  async get(): Promise<WorkspaceSettingsRecord | undefined> {
    const result = await this.pool.query(
      `SELECT default_locale, default_currency, external_adapter_mode, worker_concurrency,
              max_canvas_runs_per_day, asset_root, pricing_defaults, provider_options,
              retry_policy, version
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
         version = version + 1, updated_at = now()
       WHERE id = 1 AND version = $1
       RETURNING default_locale, default_currency, external_adapter_mode, worker_concurrency,
                 max_canvas_runs_per_day, asset_root, pricing_defaults, provider_options,
                 retry_policy, version`,
      [expectedVersion, next.defaultLocale, next.defaultCurrency, next.externalAdapterMode,
        next.workerConcurrency, next.maxCanvasRunsPerDay, next.assetRoot,
        JSON.stringify(next.pricingDefaults), JSON.stringify(next.providerOptions),
        JSON.stringify(next.retryPolicy)]
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
    version: Number(row.version)
  };
}
