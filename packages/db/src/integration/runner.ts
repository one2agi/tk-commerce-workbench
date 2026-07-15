// Single entry point that integration tests must use to get a DB pool.
//
// Behavior:
//  - When TEST_DATABASE_URL is provided AND the URL passes the loopback/_test guard,
//    connect via the standard `pg` driver (production-like path used by CI).
//  - When TEST_DATABASE_URL explicitly asks for the in-memory pglite backend
//    (set TEST_DATABASE_URL to `pglite://_test`), spin up a local-only
//    PGlite socket server on loopback port 45532 and serve a `pg.Pool` over it.
//    This is the WSL2 fallback documented in the Wave 1 Core brief.
//
// The integration runner refuses any non-loopback DB and any DB whose name does
// not end with `_test`. It NEVER falls back to DATABASE_URL.

import { strict as assert } from "node:assert";
import pg from "pg";

import { approveTestDatabaseUrl, type ApprovedDb } from "./guard.js";

export interface TestDbHandle {
  approved: ApprovedDb;
  pool: pg.Pool;
  /** Drop and recreate the public schema. Always run inside a transaction. */
  reset(): Promise<void>;
  /** Apply migration SQL or no-op if already applied (idempotency is the migrator's job). */
  migrate(sqlText: string): Promise<void>;
  close(): Promise<void>;
}

// The loopback port the embedded pglite socket server binds to. Tests run
// sequentially; overlapping suites would need unique ports which is out of scope.
const PGLITE_PORT = 45532;

interface PgliteServerHandle {
  server: { stop: () => Promise<void> };
}

async function ensurePgliteServer(): Promise<PgliteServerHandle> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { PGLiteSocketServer } = await import("@electric-sql/pglite-socket");
  const instance = new PGlite();
  const server = new PGLiteSocketServer({
    db: instance,
    port: PGLITE_PORT,
    host: "127.0.0.1",
    maxConnections: 4
  });
  await server.start();
  return {
    server: {
      stop: async () => {
        await server.stop();
      }
    }
  };
}

export async function bootTestDb(): Promise<TestDbHandle> {
  const raw = process.env["TEST_DATABASE_URL"];
  assert(
    raw,
    "TEST_DATABASE_URL is required; use a guarded PostgreSQL *_test database for the Gate, or explicitly set pglite://_test for a local compatibility run"
  );
  const usePglite = raw.startsWith("pglite://");

  let approved: ApprovedDb;
  let pgliteHandle: PgliteServerHandle | undefined;

  if (usePglite) {
    pgliteHandle = await ensurePgliteServer();
    const url = `postgres://postgres:postgres@127.0.0.1:${PGLITE_PORT}/pglite_test`;
    approved = approveTestDatabaseUrl(url);
  } else {
    approved = approveTestDatabaseUrl(raw);
  }
  assert(approved, "TEST_DATABASE_URL must be approved");

  const pool = new pg.Pool({
    connectionString: approved.url,
    max: 4,
    idleTimeoutMillis: 5_000,
    connectionTimeoutMillis: 10_000
  });
  let client: pg.PoolClient;
  try {
    client = await pool.connect();
    await client.query("SELECT 1");
  } catch (cause) {
    await pool.end().catch(() => undefined);
    if (pgliteHandle) await pgliteHandle.server.stop().catch(() => undefined);
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Cannot connect to the approved test database ${approved.database}. Create that *_test database and verify TEST_DATABASE_URL (${reason})`,
      { cause }
    );
  }

  return {
    approved,
    pool,
    async reset() {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(`DROP SCHEMA IF EXISTS "public" CASCADE`);
        await c.query(`CREATE SCHEMA "public"`);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    },
    async migrate(sqlText) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        await c.query(sqlText);
        await c.query("COMMIT");
      } catch (err) {
        await c.query("ROLLBACK").catch(() => undefined);
        throw err;
      } finally {
        c.release();
      }
    },
    async close() {
      client.release();
      await pool.end();
      if (pgliteHandle) {
        await pgliteHandle.server.stop().catch(() => undefined);
        pgliteHandle = undefined;
      }
    }
  };
}
