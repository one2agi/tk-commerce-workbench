import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "@playwright/test";
import { createLiveMiaoshouSourceAdapter } from "../packages/adapters/src/index.js";
import { bootTestDb } from "../packages/db/src/integration/runner.js";
import { INITIAL_SQL } from "../packages/db/src/migrations/0000_initial.js";

import { createWorkerApplication, type ClosableDbPool } from "../apps/worker/src/entry.js";
import { createPostHandler } from "../apps/web/src/app/api/v1/ingest-links/route.js";
import { createGetHandler } from "../apps/web/src/app/api/v1/products/route.js";
import { createExtensionTokenVerifier } from "../apps/web/src/server/auth/extension-token.js";
import { createServerServices } from "../apps/web/src/server/composition.js";
import { startMockMiaoshouServer } from "./fixtures/miaoshou-server.js";

const SAMPLE_1688_URL = "https://detail.1688.com/offer/892408514788.html?offerId=892408514788";
const EXTENSION_TOKEN = "e2e-local-extension-token";
const E2E_TEST_DATABASE_URL = process.env.TEST_DATABASE_URL ?? "pglite://_test";
const E2E_ENV = {
  NODE_ENV: "test",
  EXTERNAL_ADAPTER_MODE: "mock",
  DATABASE_URL: "postgres://postgres:postgres@127.0.0.1:5432/tk_workbench",
  TEST_DATABASE_URL: E2E_TEST_DATABASE_URL,
  LOCAL_OPERATOR_ID: "local-operator",
  EXTENSION_TOKEN,
  ALLOW_LAN: "false",
  WORKER_CONCURRENCY: "1",
  WORKER_LEASE_MS: "30000",
  MAX_CANVAS_RUNS_PER_DAY: "10"
} satisfies NodeJS.ProcessEnv;

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function requestBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

async function sendWebResponse(response: ServerResponse, webResponse: Response): Promise<void> {
  response.statusCode = webResponse.status;
  webResponse.headers.forEach((value, key) => response.setHeader(key, value));
  response.end(Buffer.from(await webResponse.arrayBuffer()));
}

async function startWebServer(input: {
  ingest: (request: Request) => Promise<Response>;
  products: (request: Request) => Promise<Response>;
}) {
  const server = createServer(async (incoming, outgoing) => {
    try {
      const address = server.address();
      if (!address || typeof address === "string" || !incoming.url) throw new Error("web server address unavailable");
      const url = `http://127.0.0.1:${address.port}${incoming.url}`;
      const body = incoming.method === "GET" || incoming.method === "HEAD"
        ? undefined
        : await requestBody(incoming);
      const request = new Request(url, {
        method: incoming.method,
        headers: {
          authorization: incoming.headers.authorization ?? "",
          "content-type": incoming.headers["content-type"] ?? "application/json"
        },
        body
      });
      const handler = incoming.url.startsWith("/api/v1/ingest-links") ? input.ingest : input.products;
      await sendWebResponse(outgoing, await handler(request));
    } catch {
      outgoing.writeHead(500, { "content-type": "application/json" });
      outgoing.end(JSON.stringify({ error: "test_web_server_failed" }));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("web server did not bind a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

test("sample 1688 URL converges duplicate collection before any paid processing starts", async () => {
  const previousTestDatabaseUrl = process.env.TEST_DATABASE_URL;
  const previousAdapterMode = process.env.EXTERNAL_ADAPTER_MODE;
  process.env.TEST_DATABASE_URL = E2E_TEST_DATABASE_URL;
  process.env.EXTERNAL_ADAPTER_MODE = "mock";
  let database: Awaited<ReturnType<typeof bootTestDb>> | undefined;
  let miaoshou: Awaited<ReturnType<typeof startMockMiaoshouServer>> | undefined;
  let assetRoot: string | undefined;
  let web: Awaited<ReturnType<typeof startWebServer>> | undefined;
  try {
    database = await bootTestDb();
    miaoshou = await startMockMiaoshouServer();
    assetRoot = await mkdtemp(join(tmpdir(), "tk-e2e-assets-"));
    await database.reset();
    await database.migrate(INITIAL_SQL);

    const services = createServerServices({
      pool: database.pool,
      config: {
        extensionToken: EXTENSION_TOKEN,
        externalAdapterMode: "mock",
        assetRoot,
        workerConcurrency: 1,
        maxCanvasRunsPerDay: 10,
        miaoshouConfigured: true,
        canvasConfigured: false,
        llmConfigured: false,
        exchangeRateConfigured: false
      }
    });
    web = await startWebServer({
      ingest: createPostHandler({
        verifyToken: createExtensionTokenVerifier(EXTENSION_TOKEN),
        service: services.ingest
      }),
      products: createGetHandler({ service: services.products })
    });

    for (const idempotencyKey of ["collect-first", "collect-duplicate"]) {
      const response = await fetch(`${web.baseUrl}/api/v1/ingest-links`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${EXTENSION_TOKEN}`,
          "content-type": "application/json"
        },
        body: JSON.stringify({
          version: 1,
          batchId: "e2e-selected-products",
          items: [{ sourceUrl: SAMPLE_1688_URL, idempotencyKey }]
        })
      });
      expect(response.status).toBe(202);
      expect((await response.json()).jobs).toHaveLength(1);
    }

    const application = createWorkerApplication({
      processKind: "e2e",
      env: {
        ...E2E_ENV,
        ASSET_ROOT: assetRoot,
      },
      miaoshou: createLiveMiaoshouSourceAdapter({
        baseUrl: miaoshou.baseUrl,
        appKey: "local-e2e-app",
        appSecret: "local-e2e-secret"
      }),
      dependencies: {
        createPool: () => database.pool as ClosableDbPool
      }
    });
    const workerResult = await application.run({
      workerId: "wave2-g2-e2e",
      maxJobs: 2
    });
    expect(workerResult.processed).toBe(2);

    const counts = await database.pool.query(`
      SELECT
        (SELECT count(*)::integer FROM products) AS products,
        (SELECT count(*)::integer FROM product_revisions) AS revisions,
        (SELECT count(*)::integer FROM miaoshou_source_records) AS source_records,
        (SELECT count(*)::integer FROM automation_runs) AS automation_runs
    `);
    expect(counts.rows[0]).toMatchObject({
      products: 1,
      revisions: 1,
      source_records: 2,
      automation_runs: 0
    });
    const sourceStates = await database.pool.query(
      "SELECT state, canonical_success_detail_id, skipped_detail_id FROM miaoshou_source_records ORDER BY created_at ASC"
    );
    expect(sourceStates.rows).toEqual([
      { state: "success", canonical_success_detail_id: "3799770548", skipped_detail_id: null },
      { state: "skipped_duplicate", canonical_success_detail_id: "3799770548", skipped_detail_id: "3799770999" }
    ]);

    const poolResponse = await fetch(`${web.baseUrl}/api/v1/products`);
    expect(poolResponse.status).toBe(200);
    const poolView = await poolResponse.json();
    expect(poolView.items).toHaveLength(1);
    expect(poolView.items[0]).toMatchObject({
      sourceItemId: "892408514788",
      canonicalSuccessDetailId: "3799770548",
      miaoshouSource: "success",
      automation: "not_started"
    });

    expect(application.counters()).toMatchObject({
      llm: 0,
      exchangeRate: 0,
      canvas: 0,
      assetStaging: 0
    });
    expect(miaoshou.calls).toHaveLength(6);
    expect(await database.pool.query("SELECT kind, status FROM jobs ORDER BY created_at")).toMatchObject({
      rows: [
        { kind: "miaoshou_collect", status: "succeeded" },
        { kind: "miaoshou_collect", status: "succeeded" }
      ]
    });
  } finally {
    await web?.close();
    await miaoshou?.close();
    await database?.close();
    if (assetRoot) await rm(assetRoot, { recursive: true, force: true });
    restoreEnvironment("TEST_DATABASE_URL", previousTestDatabaseUrl);
    restoreEnvironment("EXTERNAL_ADAPTER_MODE", previousAdapterMode);
  }
});
