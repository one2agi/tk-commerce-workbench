// Exchange rate snapshot repository.
// `record()` for provider snapshots, `recordManualOverride()` for manual rate overrides.
// Both preserve `source` and `observedAt` provenance so the UI can distinguish stale vs
// fresh vs manual.

import { strict as assert } from "node:assert";

import { schema, type DbPool, type ExchangeRateRow } from "../schema/index.js";

function newId(prefix: string): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${t}${r}`;
}

export class ExchangeRateRepository {
  constructor(
    private readonly pool: DbPool,
    private readonly _schema: typeof schema = schema
  ) {}

  async record(input: {
    base: string;
    target: string;
    rate: string;
    source: "provider" | "manual";
    observedAt: string;
    isStale?: boolean;
  }): Promise<string> {
    assert(input.base.length > 0, "base required");
    assert(input.target.length > 0, "target required");
    assert(input.source === "provider" || input.source === "manual", "source invalid");
    const id = newId("fx");
    await this.pool.query(
      `INSERT INTO ${schema.exchangeRateSnapshots}
       (id, base, target, rate, source, observed_at, is_stale)
       VALUES ($1, $2, $3, $4, $5, $6::timestamptz, $7)`,
      [
        id,
        input.base,
        input.target,
        input.rate,
        input.source,
        input.observedAt,
        input.isStale ?? false
      ]
    );
    return id;
  }

  async recordManualOverride(input: {
    base: string;
    target: string;
    rate: string;
    observedAt: string;
  }): Promise<string> {
    return this.record({
      base: input.base,
      target: input.target,
      rate: input.rate,
      source: "manual",
      observedAt: input.observedAt,
      isStale: false
    });
  }

  async listAll(): Promise<ExchangeRateRow[]> {
    const r = await this.pool.query(
      `SELECT id, base, target, rate, source, observed_at, is_stale, created_at
       FROM ${schema.exchangeRateSnapshots}
       ORDER BY observed_at DESC`
    );
    return r.rows.map((row) => ({
      id: row.id,
      base: row.base,
      target: row.target,
      rate: row.rate,
      source: row.source,
      observedAt: new Date(row.observed_at),
      isStale: row.is_stale,
      createdAt: new Date(row.created_at)
    }));
  }
}
