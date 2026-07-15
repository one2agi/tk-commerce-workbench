// Test-only guard. The integration runner must refuse any DB that is not loopback
// and whose name does not end with `_test`. We never fall back to DATBASE_URL.

import { strict as assert } from "node:assert";

export interface ApprovedDb {
  url: string;
  host: string;
  port: number;
  database: string;
}

export function approveTestDatabaseUrl(rawUrl: string | undefined): ApprovedDb {
  assert(rawUrl, "TEST_DATABASE_URL is required");
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error(`TEST_DATABASE_URL is not a parseable URL: ${rawUrl}`);
  }
  // postgres://user:pass@host:port/db
  // pg uses query params in some configs; we accept either host or hostname-ish fields.
  const host = url.hostname;
  const port = url.port ? Number(url.port) : 5432;
  const database = url.pathname.replace(/^\//, "");
  assert(database && database.length > 0, `TEST_DATABASE_URL must include database name: ${rawUrl}`);
  assert(
    database.endsWith("_test"),
    `TEST_DATABASE_URL database must end with "_test" (was: ${database})`
  );
  assert(
    host === "127.0.0.1" || host === "::1" || host === "localhost",
    `TEST_DATABASE_URL host must be loopback (was: ${host}); refuse to run against non-loopback DB`
  );

  return { url: rawUrl, host, port, database };
}
