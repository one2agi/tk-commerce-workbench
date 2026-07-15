import { strict as assert } from "node:assert";
import { schema, type DbPool } from "../schema/index.js";

export class CanvasQuotaRepository {
  constructor(private readonly pool: DbPool) {}

  async reserve(input: { runKey: string; day: string; limit: number }): Promise<boolean> {
    assert(input.runKey.length > 0, "runKey required");
    assert(/^\d{4}-\d{2}-\d{2}$/.test(input.day), "day must be YYYY-MM-DD");
    assert(Number.isInteger(input.limit) && input.limit > 0, "limit must be positive");
    const existing = await this.pool.query(
      `SELECT 1 FROM ${schema.canvasDailyReservations} WHERE day_key = $1::date AND run_key = $2`,
      [input.day, input.runKey]
    );
    if ((existing.rowCount ?? 0) > 0) return true;

    for (let slot = 1; slot <= input.limit; slot++) {
      const inserted = await this.pool.query(
        `INSERT INTO ${schema.canvasDailyReservations} (day_key, slot, run_key)
         VALUES ($1::date, $2, $3)
         ON CONFLICT DO NOTHING
         RETURNING run_key`,
        [input.day, slot, input.runKey]
      );
      if ((inserted.rowCount ?? 0) > 0) return true;
      const reused = await this.pool.query(
        `SELECT 1 FROM ${schema.canvasDailyReservations} WHERE day_key = $1::date AND run_key = $2`,
        [input.day, input.runKey]
      );
      if ((reused.rowCount ?? 0) > 0) return true;
    }
    return false;
  }
}
