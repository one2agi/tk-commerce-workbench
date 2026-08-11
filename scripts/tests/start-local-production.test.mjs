import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import {
  buildWorkerEnvironment,
  buildRuntimeEnvironment,
  mergeNoProxy,
  readEnvFile,
  resolveEnvFilePath,
  sanitizeProxyEnvironment
} from "../start-local-production.mjs";

test("sanitizeProxyEnvironment removes proxy variables and preserves loopback bypass", () => {
  const env = sanitizeProxyEnvironment({
    PATH: "/bin",
    HTTP_PROXY: "http://proxy.invalid",
    HTTPS_PROXY: "http://proxy.invalid",
    http_proxy: "http://proxy.invalid",
    NODE_TLS_REJECT_UNAUTHORIZED: "0",
    TMPDIR: "/mnt/c/Users/morav/AppData/Local/Temp",
    TMP: "/mnt/c/Users/morav/AppData/Local/Temp",
    TEMP: "/mnt/c/Users/morav/AppData/Local/Temp",
    NO_PROXY: "example.test"
  });

  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.HTTPS_PROXY, undefined);
  assert.equal(env.http_proxy, undefined);
  assert.equal(env.NODE_TLS_REJECT_UNAUTHORIZED, undefined);
  assert.equal(env.NO_PROXY, "example.test,127.0.0.1,localhost,::1");
  assert.equal(env.no_proxy, env.NO_PROXY);
  if (process.platform === "linux") {
    assert.equal(env.TMPDIR, "/tmp");
    assert.equal(env.TMP, "/tmp");
    assert.equal(env.TEMP, "/tmp");
  }
});

test("mergeNoProxy is idempotent for loopback hosts", () => {
  assert.equal(
    mergeNoProxy("127.0.0.1,localhost"),
    "127.0.0.1,localhost,::1"
  );
});

test("buildRuntimeEnvironment injects production launch context and live worker ids", () => {
  const env = buildRuntimeEnvironment({
    launchId: "launch_1",
    hostEnv: {
      PATH: "/bin",
      HTTP_PROXY: "http://proxy.invalid",
      NO_PROXY: "custom"
    },
    envFile: {
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench",
      EXTERNAL_ADAPTER_MODE: "live",
      NO_PROXY: "127.0.0.1,localhost"
    }
  });

  assert.equal(env.NODE_ENV, "production");
  assert.equal(env.TK_RUNTIME_LAUNCH_ID, "launch_1");
  assert.equal(env.WORKER_COMMAND_ID, "local-production-launch_1");
  assert.equal(env.WORKER_IDEMPOTENCY_KEY, "local-production-launch_1-worker");
  assert.equal(env.HTTP_PROXY, undefined);
  assert.equal(env.NO_PROXY, "127.0.0.1,localhost,::1");
  if (process.platform === "linux") {
    assert.equal(env.TMPDIR, "/tmp");
    assert.equal(env.TEMP, "/tmp");
  }
});

test("buildWorkerEnvironment restores external proxy variables for live adapters", () => {
  const runtimeEnv = buildRuntimeEnvironment({
    launchId: "launch_1",
    hostEnv: {
      PATH: "/bin",
      HTTP_PROXY: "http://127.0.0.1:6984",
      HTTPS_PROXY: "http://127.0.0.1:6984",
      NO_PROXY: "custom.internal"
    },
    envFile: {
      DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench",
      EXTERNAL_ADAPTER_MODE: "live"
    }
  });

  const workerEnv = buildWorkerEnvironment({
    runtimeEnv,
    hostEnv: {
      HTTP_PROXY: "http://127.0.0.1:6984",
      HTTPS_PROXY: "http://127.0.0.1:6984",
      NO_PROXY: "custom.internal"
    },
    workerReadyPath: "/tmp/worker-ready.json"
  });

  assert.equal(runtimeEnv.HTTP_PROXY, undefined);
  assert.equal(runtimeEnv.HTTPS_PROXY, undefined);
  assert.equal(workerEnv.HTTP_PROXY, "http://127.0.0.1:6984");
  assert.equal(workerEnv.HTTPS_PROXY, "http://127.0.0.1:6984");
  assert.equal(workerEnv.NO_PROXY, "custom.internal,127.0.0.1,localhost,::1");
  assert.equal(workerEnv.no_proxy, workerEnv.NO_PROXY);
  assert.equal(workerEnv.TK_WORKER_READY_PATH, "/tmp/worker-ready.json");
  assert.equal(workerEnv.PGAPPNAME, "tk-workbench-local-worker");
});

test("readEnvFile parses simple env assignments", () => {
  assert.deepEqual(readEnvFile("A=1\n# comment\nB=value with spaces\n"), {
    A: "1",
    B: "value with spaces"
  });
});

test("resolveEnvFilePath prefers storage env over repo env", async () => {
  const tempRoot = process.platform === "linux" ? "/tmp" : process.env.TEMP ?? process.cwd();
  const root = await mkdtemp(join(tempRoot, "tk-repo-"));
  const storage = await mkdtemp(join(tempRoot, "tk-storage-"));
  await writeFile(join(root, ".env"), "A=root\n");
  await writeFile(join(storage, ".env"), "A=storage\n");

  assert.equal(resolveEnvFilePath({ repoRoot: root, storageDir: storage }), join(storage, ".env"));
});
