import pg from "../../packages/db/node_modules/pg/lib/index.js";

import { approveTestDatabaseUrl } from "../../packages/db/src/integration/guard.js";

export async function openE2eDatabase(rawUrl: string | undefined) {
  if (rawUrl?.startsWith("pglite://")) {
    throw new Error("G3 DB-backed E2E requires an explicit loopback PostgreSQL *_test database");
  }
  const approved = approveTestDatabaseUrl(rawUrl);
  const pool = new pg.Pool({ connectionString: approved.url, max: 4, connectionTimeoutMillis: 10_000 });
  await pool.query("SELECT 1");
  return {
    approved,
    pool,
    async reset() {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`DROP SCHEMA IF EXISTS "public" CASCADE`);
        await client.query(`CREATE SCHEMA "public"`);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async migrate(sql: string) {
      await pool.query(sql);
    },
    async close() {
      await pool.end();
    }
  };
}
