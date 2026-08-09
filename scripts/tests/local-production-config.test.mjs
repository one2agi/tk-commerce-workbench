import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  initializeLocalProduction,
  parseMiaoshouCredentials,
  syncLiveProductionEnv
} from "../local-production-config.mjs";

test("parses labeled Miaoshou credentials across CRLF or whitespace", () => {
  assert.deepEqual(
    parseMiaoshouCredentials("APP ID: demo-id\r\nAPP Secret: demo-secret"),
    {
      appKey: "demo-id",
      appSecret: "demo-secret"
    }
  );
});

test("rejects credential values that are unsafe to render in an env file", () => {
  const unsafeCredentials = [
    "APP ID: demo=id\nAPP Secret: demo-secret",
    "APP ID: demo-id\nAPP Secret: demo\0secret",
    "APP ID:\nINJECTED\nAPP Secret: demo-secret"
  ];

  for (const credentials of unsafeCredentials) {
    assert.throws(() => parseMiaoshouCredentials(credentials), /invalid|required/i);
  }
});

test("creates a private mock-only env and runtime directories", async () => {
  const permissionCapableTempRoot =
    process.platform === "linux" ? "/tmp" : tmpdir();
  const storageDir = await mkdtemp(
    join(permissionCapableTempRoot, "tk-local-production-")
  );
  const credentialFile = join(storageDir, "credentials.txt");
  await writeFile(
    credentialFile,
    "APP ID: demo-id\nAPP Secret: demo-secret"
  );
  await initializeLocalProduction({ credentialFile, storageDir });
  const env = await readFile(join(storageDir, ".env"), "utf8");
  assert.match(env, /^EXTERNAL_ADAPTER_MODE=mock$/m);
  assert.match(env, /^ALLOW_LAN=false$/m);
  assert.match(env, /^MIAOSHOU_APP_KEY=demo-id$/m);
  assert.match(env, /^EXTENSION_TOKEN=[A-Za-z0-9_-]{43}$/m);
  const assetDirectory = await stat(join(storageDir, "data/assets"));
  const runtimeDirectory = await stat(join(storageDir, "data/runtime"));
  assert.equal(assetDirectory.isDirectory(), true);
  assert.equal(runtimeDirectory.isDirectory(), true);

  if (process.platform !== "win32") {
    assert.equal(assetDirectory.mode & 0o777, 0o700);
    assert.equal(runtimeDirectory.mode & 0o777, 0o700);
    assert.equal((await stat(join(storageDir, ".env"))).mode & 0o777, 0o600);
  }
});

test("refuses to overwrite an existing env", async () => {
  const storageDir = await mkdtemp(
    join(tmpdir(), "tk-local-production-existing-")
  );
  const credentialFile = join(storageDir, "credentials.txt");
  await writeFile(join(storageDir, ".env"), "KEEP=1\n");
  await writeFile(
    credentialFile,
    "APP ID: demo-id\nAPP Secret: demo-secret"
  );
  await assert.rejects(
    () => initializeLocalProduction({ credentialFile, storageDir }),
    /already exists/
  );
});

test("sync-live copies only allowed runtime keys, preserves loopback safety, and writes explicit live ack", async () => {
  const storageDir = await mkdtemp(join(tmpdir(), "tk-local-production-live-"));
  const sourceEnvFile = join(storageDir, "source.env");
  await writeFile(sourceEnvFile, [
    "DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/tk_workbench",
    "TEST_DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/tk_workbench_test",
    "LOCAL_OPERATOR_ID=local-operator",
    "EXTENSION_TOKEN=extension-secret",
    "NO_PROXY=127.0.0.1,localhost",
    "no_proxy=127.0.0.1,localhost",
    "ALLOW_LAN=true",
    "EXTERNAL_ADAPTER_MODE=mock",
    "MIAOSHOU_APP_KEY=miaoshou-key",
    "MIAOSHOU_APP_SECRET=miaoshou-secret",
    "CANVAS_BASE_URL=http://127.0.0.1:8123",
    "CANVAS_API_KEY=",
    "CANVAS_ID=canvas-id",
    "CANVAS_WORKFLOW_NAME=TK工作流",
    "LLM_BASE_URL=https://api.siliconflow.cn/v1",
    "LLM_API_KEY=llm-secret",
    "LLM_MODEL=deepseek-ai/DeepSeek-V4-Flash",
    "IMAGE_PLANNER_BASE_URL=https://planner.test/v1",
    "IMAGE_PLANNER_API_KEY=planner-secret",
    "IMAGE_PLANNER_MODEL=planner-model",
    "IMAGE_PROVIDER_BASE_URL=https://api.apimart.ai/v1/images/generations",
    "IMAGE_PROVIDER_API_KEY=image-secret",
    "IMAGE_PROVIDER_MODEL=gpt-image-2",
    "EXCHANGE_RATE_BASE_URL=https://rates.test/latest",
    "ASSET_ROOT=/tmp/tk-assets",
    "WORKER_CONCURRENCY=2",
    "MAX_CANVAS_RUNS_PER_DAY=50",
    "UNRELATED_SECRET=must-not-copy"
  ].join("\n"));

  const result = await syncLiveProductionEnv({ sourceEnvFile, storageDir });
  const env = await readFile(join(storageDir, ".env"), "utf8");

  assert.match(env, /^EXTERNAL_ADAPTER_MODE=live$/m);
  assert.match(env, /^LOCAL_PRODUCTION_LIVE_ACK=full-live-local-mvp$/m);
  assert.match(env, /^ALLOW_LAN=false$/m);
  assert.match(env, /^NO_PROXY=127\.0\.0\.1,localhost$/m);
  assert.match(env, /^no_proxy=127\.0\.0\.1,localhost$/m);
  assert.match(env, /^CANVAS_BASE_URL=http:\/\/127\.0\.0\.1:8123$/m);
  assert.match(env, /^CANVAS_ID=canvas-id$/m);
  assert.match(env, /^CANVAS_WORKFLOW_NAME=TK工作流$/m);
  assert.match(env, /^LLM_MODEL=deepseek-ai\/DeepSeek-V4-Flash$/m);
  assert.match(env, /^IMAGE_PLANNER_MODEL=planner-model$/m);
  assert.match(env, /^IMAGE_PROVIDER_BASE_URL=https:\/\/api\.apimart\.ai\/v1\/images\/generations$/m);
  assert.match(env, /^IMAGE_PROVIDER_MODEL=gpt-image-2$/m);
  assert.equal(env.includes("UNRELATED_SECRET"), false);
  assert.equal(JSON.stringify(result).includes("llm-secret"), false);
  assert.equal(JSON.stringify(result).includes("miaoshou-secret"), false);
  assert.equal(JSON.stringify(result).includes("planner-secret"), false);
  assert.equal(JSON.stringify(result).includes("image-secret"), false);
  assert.equal(result.status.LLM_API_KEY, "set");
  assert.equal(result.status.CANVAS_API_KEY, "empty");
});
