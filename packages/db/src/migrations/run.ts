import { pathToFileURL } from "node:url";

import pg from "pg";

import { INITIAL_SQL } from "./0000_initial.js";

export async function runInitialMigration(databaseUrl: string): Promise<void> {
  if (!databaseUrl.trim()) throw new Error("DATABASE_URL is required for db:migrate");
  const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(INITIAL_SQL);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

async function main(): Promise<void> {
  const databaseUrl = process.env["DATABASE_URL"];
  if (!databaseUrl) throw new Error("DATABASE_URL is required for db:migrate");
  await runInitialMigration(databaseUrl);
  process.stdout.write("Initial database migration applied successfully.\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
