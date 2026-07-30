import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createRuntimeHealthHandler } from "../../apps/web/src/app/api/runtime-health/route.js";

import {
  assertLogsAreRedacted,
  assertSafeRuntimeEnv,
  buildChildEnvironment,
  buildWorkerCommand,
  buildWorkerProbeClientConfig,
  captureProcessIdentity,
  cleanupFailedStart,
  cleanupProvisionalProcess,
  cleanupSpawnFailure,
  acquireStartLock,
  envPathFor,
  groupExists,
  hasNewWorkerBackend,
  processIsManaged,
  readEnvFile,
  resolveStorageDir,
  runtimeDirFor,
  runtimePublicInfo,
  secretNeedles,
  startLocalProduction,
  statusLocalProduction,
  stopLocalProduction,
  stopManagedProcess,
  WEB_MARKER,
  WORKER_MARKER,
  writeProcessMetadata
} from "../local-production-runtime.mjs";

// Redirect storage to a per-test tmpdir so tests never touch the real
// ~/.local/share/tk-commerce-workbench path. The override is restored in
// afterEach via the snapshot in the test runner.
const ORIGINAL_STORAGE_DIR = process.env.TK_WORKBENCH_STORAGE_DIR;

async function withTestStorageDir(callback) {
  const storageDir = await mkdtemp(join(tmpdir(), "tk-runtime-storage-"));
  process.env.TK_WORKBENCH_STORAGE_DIR = storageDir;
  try {
    await mkdir(runtimeDirFor(), { recursive: true });
    await callback(storageDir);
  } finally {
    if (ORIGINAL_STORAGE_DIR === undefined) {
      delete process.env.TK_WORKBENCH_STORAGE_DIR;
    } else {
      process.env.TK_WORKBENCH_STORAGE_DIR = ORIGINAL_STORAGE_DIR;
    }
  }
}

async function waitForManagedProcess(pid, marker) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await processIsManaged(pid, marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`dummy process ${pid} did not expose marker ${marker}`);
}

test("runtime health endpoint exposes a non-secret launch id without authentication", async () => {
  const handler = createRuntimeHealthHandler({
    launchId: "launch-123",
    adapterMode: "live",
    canvasBaseUrlKind: "loopback",
    canvasWorkflowName: "TK工作流"
  });
  const response = await handler(
    new Request("http://127.0.0.1/api/runtime-health")
  );
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    launchId: "launch-123",
    adapterMode: "live",
    canvasBaseUrlKind: "loopback",
    canvasWorkflowName: "TK工作流"
  });
});

async function spawnManagedDummy(
  marker,
  launchId = `launch-${process.pid}-${Date.now()}`
) {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", marker],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TK_RUNTIME_LAUNCH_ID: launchId }
    }
  );
  child.unref();
  await waitForManagedProcess(child.pid, marker);
  return { pid: child.pid, launchId };
}

async function spawnManagedDummyIdentity(
  marker,
  source = "setInterval(() => {}, 1000)",
  launchId = `launch-${process.pid}-${Date.now()}`
) {
  const child = spawn(process.execPath, ["-e", source, marker], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, TK_RUNTIME_LAUNCH_ID: launchId }
  });
  child.unref();
  await waitForManagedProcess(child.pid, marker);
  return { ...(await captureProcessIdentity(child.pid, marker)), launchId };
}

async function forceStopGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

test("env parser treats values as data rather than shell", () => {
  assert.deepEqual(readEnvFile("SAFE=$(touch /tmp/never-run)\nMODE=mock\nno_proxy=127.0.0.1,localhost\n"), {
    SAFE: "$(touch /tmp/never-run)",
    MODE: "mock",
    no_proxy: "127.0.0.1,localhost"
  });
});

test("env parser rejects malformed, duplicate, and NUL assignments", () => {
  assert.throws(() => readEnvFile("not-an-assignment\n"), /invalid env assignment/);
  assert.throws(() => readEnvFile("SAFE=one\nSAFE=two\n"), /duplicate env key/);
  assert.throws(() => readEnvFile("unsafe=value\n"), /invalid env key/);
  assert.throws(() => readEnvFile("SAFE=one\0two\n"), /env contains NUL/);
});

test("child environment inherits only an allowlist plus the env file", () => {
  const childEnv = buildChildEnvironment(
    { DATABASE_URL: "postgresql://local", APP_SECRET: "configured-secret" },
    {
      launchId: "launch-123",
      hostEnv: {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        LANG: "C.UTF-8",
        HTTP_PROXY: "http://127.0.0.1:6984",
        HTTPS_PROXY: "http://127.0.0.1:6984",
        AWS_SECRET_ACCESS_KEY: "ambient-secret",
        NODE_OPTIONS: "--inspect"
      }
    }
  );

  assert.deepEqual(childEnv, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    HTTP_PROXY: "http://127.0.0.1:6984",
    HTTPS_PROXY: "http://127.0.0.1:6984",
    DATABASE_URL: "postgresql://local",
    APP_SECRET: "configured-secret",
    NODE_ENV: "production",
    TMPDIR: join("/tmp", "tk-commerce-workbench-runtime", String(process.getuid?.() ?? "user"), "launch-123"),
    TMP: join("/tmp", "tk-commerce-workbench-runtime", String(process.getuid?.() ?? "user"), "launch-123"),
    TEMP: join("/tmp", "tk-commerce-workbench-runtime", String(process.getuid?.() ?? "user"), "launch-123"),
    TK_RUNTIME_LAUNCH_ID: "launch-123"
  });
});

test("child environment uses a Linux-native runtime tmp directory", async () => {
  await withTestStorageDir(async (storageDir) => {
    const childEnv = buildChildEnvironment(
      { DATABASE_URL: "postgresql://local" },
      {
        launchId: "launch-123",
        hostEnv: {
          PATH: "/usr/bin",
          TMPDIR: "/mnt/c/Users/morav/AppData/Local/Temp",
          TMP: "/mnt/c/Users/morav/AppData/Local/Temp",
          TEMP: "/mnt/c/Users/morav/AppData/Local/Temp"
        }
      }
    );

    assert.ok(storageDir);
    assert.equal(
      childEnv.TMPDIR,
      join("/tmp", "tk-commerce-workbench-runtime", String(process.getuid?.() ?? "user"), "launch-123")
    );
    assert.equal(childEnv.TMP, childEnv.TMPDIR);
    assert.equal(childEnv.TEMP, childEnv.TMPDIR);
  });
});

test("live child environment injects stable worker command context", () => {
  const childEnv = buildChildEnvironment(
    {
      EXTERNAL_ADAPTER_MODE: "live",
      LOCAL_PRODUCTION_LIVE_ACK: "full-live-local-mvp"
    },
    { launchId: "launch-live-123", hostEnv: {} }
  );

  assert.equal(childEnv.WORKER_COMMAND_ID, "local-production-launch-live-123");
  assert.equal(childEnv.WORKER_IDEMPOTENCY_KEY, "local-production-launch-live-123-worker");
});

test("runtime safety keeps mock as default and requires explicit full-live acknowledgement", () => {
  assert.doesNotThrow(() => assertSafeRuntimeEnv({
    EXTERNAL_ADAPTER_MODE: "mock",
    ALLOW_LAN: "false",
    DATABASE_URL: "postgresql://fixture-user:fixture-password@127.0.0.1/db"
  }));

  assert.throws(() => assertSafeRuntimeEnv({
    EXTERNAL_ADAPTER_MODE: "live",
    ALLOW_LAN: "false",
    DATABASE_URL: "postgresql://fixture-user:fixture-password@127.0.0.1/db"
  }), /LOCAL_PRODUCTION_LIVE_ACK/);
});

test("runtime safety validates all full-live external configuration without printing values", () => {
  const base = {
    EXTERNAL_ADAPTER_MODE: "live",
    LOCAL_PRODUCTION_LIVE_ACK: "full-live-local-mvp",
    ALLOW_LAN: "false",
    DATABASE_URL: "postgresql://fixture-user:fixture-password@127.0.0.1/db",
    CANVAS_BASE_URL: "http://127.0.0.1:8123",
    CANVAS_ID: "canvas-id",
    CANVAS_WORKFLOW_NAME: "TK工作流",
    LLM_BASE_URL: "https://llm.test/v1",
    LLM_API_KEY: "llm-secret",
    LLM_MODEL: "model-id",
    EXCHANGE_RATE_BASE_URL: "https://rates.test/latest",
    MIAOSHOU_APP_KEY: "miaoshou-key",
    MIAOSHOU_APP_SECRET: "miaoshou-secret"
  };
  assert.doesNotThrow(() => assertSafeRuntimeEnv(base));

  for (const key of [
    "CANVAS_BASE_URL", "CANVAS_ID", "CANVAS_WORKFLOW_NAME", "LLM_BASE_URL",
    "LLM_API_KEY", "LLM_MODEL", "EXCHANGE_RATE_BASE_URL",
    "MIAOSHOU_APP_KEY", "MIAOSHOU_APP_SECRET"
  ]) {
    const env = { ...base, [key]: "" };
    assert.throws(
      () => assertSafeRuntimeEnv(env),
      (error) => {
        assert.match(error.message, new RegExp(key));
        assert.equal(error.message.includes("llm-secret"), false);
        assert.equal(error.message.includes("miaoshou-secret"), false);
        return true;
      }
    );
  }
});

test("runtime public info exposes only non-secret adapter and Canvas fields", () => {
  assert.deepEqual(runtimePublicInfo({
    EXTERNAL_ADAPTER_MODE: "live",
    CANVAS_BASE_URL: "http://127.0.0.1:8123",
    CANVAS_WORKFLOW_NAME: "TK工作流",
    CANVAS_API_KEY: "canvas-secret"
  }), {
    adapterMode: "live",
    canvasBaseUrlKind: "loopback",
    canvasWorkflowName: "TK工作流"
  });

  assert.deepEqual(runtimePublicInfo({
    EXTERNAL_ADAPTER_MODE: "mock",
    CANVAS_BASE_URL: "https://canvas.example.test",
    CANVAS_WORKFLOW_NAME: "remote-workflow"
  }), {
    adapterMode: "mock",
    canvasBaseUrlKind: "remote",
    canvasWorkflowName: "remote-workflow"
  });
});

test("launch id is not classified as a secret", () => {
  const childEnv = buildChildEnvironment(
    { APP_SECRET: "real-secret" },
    { launchId: "visible-launch-id", hostEnv: {} }
  );
  assert.equal(secretNeedles(childEnv).includes("visible-launch-id"), false);
  assert.equal(secretNeedles(childEnv).includes("real-secret"), true);
});

test("worker command keeps the exact fixed PGAPPNAME contract", () => {
  assert.deepEqual(buildWorkerCommand(), {
    command: "env",
    args: [
      "PGAPPNAME=tk-workbench-local-worker",
      "pnpm",
      "--filter",
      "@tk/worker",
      "start"
    ]
  });
});

test("worker readiness requires a backend PID outside the startup baseline", () => {
  assert.equal(hasNewWorkerBackend([101, 102], [101, 102]), false);
  assert.equal(hasNewWorkerBackend([101, 102], [101, 102, 103]), true);
});

test("worker baseline probe cannot masquerade as the worker session", () => {
  assert.deepEqual(buildWorkerProbeClientConfig("postgresql://local/db"), {
    connectionString: "postgresql://local/db",
    connectionTimeoutMillis: 1_000,
    application_name: "tk-workbench-local-runtime-probe"
  });
});

test("process metadata uses exclusive creation", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-metadata-"));
  const metadataPath = join(repoRoot, "processes.json");
  const metadata = {
    version: 1,
    launchId: "launch-123",
    web: {
      pid: 101,
      pgid: 101,
      startTimeTicks: "1001",
      marker: "web-marker",
      launchId: "launch-123"
    },
    worker: {
      pid: 202,
      pgid: 202,
      startTimeTicks: "2002",
      marker: "worker-marker",
      launchId: "launch-123",
      baselineBackendPids: []
    }
  };

  await writeProcessMetadata(metadataPath, metadata);
  assert.deepEqual(JSON.parse(await readFile(metadataPath, "utf8")), metadata);
  await assert.rejects(
    () => writeProcessMetadata(metadataPath, metadata),
    /already exists/i
  );
});

test("stale PIDs are not accepted as managed", async () => {
  assert.equal(await processIsManaged(2 ** 31 - 1, "stale-marker"), false);
  assert.equal(await processIsManaged(0, "stale-marker"), false);
});

test("process identity rejects PID reuse when Linux start time differs", async () => {
  const marker = process.argv[0].split("/").at(-1);
  const identity = await captureProcessIdentity(process.pid, marker);

  assert.equal(await processIsManaged(identity), true);
  assert.equal(
    await processIsManaged({
      ...identity,
      startTimeTicks: String(BigInt(identity.startTimeTicks) + 1n)
    }),
    false
  );
});

test("stop refuses a live PID whose command line lacks the marker", async () => {
  const identity = await captureProcessIdentity(process.pid, "node");
  await assert.rejects(
    () => stopManagedProcess({
      ...identity,
      marker: "definitely-not-present",
      launchId: "not-present-on-current-process"
    }),
    new RegExp(`refusing unmanaged PID ${process.pid}`)
  );
});

test("stop terminates a managed dummy process group within the bound", async () => {
  const marker = `tk-runtime-stop-${process.pid}-${Date.now()}`;
  const spawned = await spawnManagedDummy(marker);
  const identity = {
    ...(await captureProcessIdentity(spawned.pid, marker)),
    launchId: spawned.launchId
  };

  try {
    await stopManagedProcess({ ...identity, waitMs: 1_000 });
    assert.equal(await processIsManaged(spawned.pid, marker), false);
  } finally {
    await forceStopGroup(spawned.pid);
  }
});

test("stop removes the whole process group after its leader exits", async () => {
  const marker = `tk-runtime-orphan-${process.pid}-${Date.now()}`;
  const identity = await spawnManagedDummyIdentity(
    marker,
    `const { spawn } = require("node:child_process");
     const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[1]], { stdio: "ignore" });
     child.unref();
     setTimeout(() => process.exit(0), 100);`
  );
  const deadline = Date.now() + 2_000;
  while (await processIsManaged(identity)) {
    if (Date.now() >= deadline) throw new Error("dummy leader did not exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await groupExists(identity.pgid), true);

  try {
    await stopManagedProcess({ ...identity, waitMs: 500 });
    assert.equal(await groupExists(identity.pgid), false);
  } finally {
    await forceStopGroup(identity.pgid);
  }
});

test("stop polls for group exit after escalating to SIGKILL", async () => {
  const marker = `tk-runtime-kill-${process.pid}-${Date.now()}`;
  const identity = await spawnManagedDummyIdentity(
    marker,
    "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"
  );

  try {
    await stopManagedProcess({ ...identity, waitMs: 20 });
    assert.equal(await groupExists(identity.pgid), false);
  } finally {
    await forceStopGroup(identity.pgid);
  }
});

test("provisional cleanup removes same-PGID children after the leader exits before identity capture", async () => {
  const marker = `tk-runtime-provisional-${process.pid}-${Date.now()}`;
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const { spawn } = require("node:child_process");
       const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[1]], { stdio: "ignore" });
       child.unref();
       setTimeout(() => process.exit(0), 50);`,
      marker
    ],
    {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, TK_RUNTIME_LAUNCH_ID: "provisional-launch" }
    }
  );
  leader.unref();
  const deadline = Date.now() + 2_000;
  while (await processIsManaged(leader.pid, marker)) {
    if (Date.now() >= deadline) throw new Error("provisional leader did not exit");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(await groupExists(leader.pid), true);

  try {
    await cleanupProvisionalProcess({
      pid: leader.pid,
      pgid: leader.pid,
      marker,
      launchId: "provisional-launch",
      waitMs: 500
    });
    assert.equal(await groupExists(leader.pid), false);
  } finally {
    await forceStopGroup(leader.pid);
  }
});

test("failed provisional cleanup preserves validated recovery metadata", async () => {
  await withTestStorageDir(async () => {
    const metadataPath = join(runtimeDirFor(), "processes.json");
    const record = {
      pid: 4242,
      pgid: 4242,
      marker: "provisional-marker",
      launchId: "recovery-launch"
    };

    await assert.rejects(
      () => cleanupSpawnFailure({
        records: [record],
        metadataPath,
        originalError: new Error("identity capture failed"),
        stopRecord: async () => {
          throw new Error("provisional group survived SIGKILL");
        }
      }),
      /identity capture failed.*survived SIGKILL/s
    );
    assert.deepEqual(JSON.parse(await readFile(metadataPath, "utf8")), {
      version: 1,
      state: "recovery",
      launchId: "recovery-launch",
      records: [record]
    });

    await assert.rejects(
      () => stopLocalProduction({ waitMs: 20 }),
      /unverified provisional PGID.*manual cleanup required/i
    );
    assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).state, "recovery");
  });
});

test("start rejects a missing env before spawning anything", async () => {
  await withTestStorageDir(async () => {
    await assert.rejects(
      () => startLocalProduction({ repoRoot: "/nonexistent" }),
      /\.env.*required/i
    );
  });
});

test("status rejects stale process metadata", async () => {
  await withTestStorageDir(async () => {
    const runtimeRoot = runtimeDirFor();
    await writeFile(
      envPathFor(),
      "EXTERNAL_ADAPTER_MODE=mock\nALLOW_LAN=false\nDATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1/db\n"
    );
    await writeFile(
      join(runtimeRoot, "processes.json"),
      JSON.stringify({
        version: 1,
        launchId: "launch-123",
        web: {
          pid: 2 ** 31 - 1,
          pgid: 2 ** 31 - 1,
          startTimeTicks: "1001",
          marker: "stale-web",
          launchId: "launch-123"
        },
        worker: {
          pid: 2 ** 31 - 2,
          pgid: 2 ** 31 - 2,
          startTimeTicks: "2002",
          marker: "stale-worker",
          launchId: "launch-123",
          baselineBackendPids: []
        }
      })
    );

    await assert.rejects(
      () => statusLocalProduction({ waitMs: 50 }),
      /stale|not managed/i
    );
  });
});

test("status rejects a reused PID even when its command marker matches", async () => {
  const marker = `tk-runtime-reused-${process.pid}-${Date.now()}`;
  const actual = await spawnManagedDummyIdentity(marker);
  const stale = {
    ...actual,
    startTimeTicks: String(BigInt(actual.startTimeTicks) + 1n)
  };
  try {
    await withTestStorageDir(async () => {
      const runtimeRoot = runtimeDirFor();
      await writeFile(
        envPathFor(),
        "EXTERNAL_ADAPTER_MODE=mock\nALLOW_LAN=false\nDATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1/db\n"
      );
      await writeFile(
        join(runtimeRoot, "processes.json"),
        JSON.stringify({
          version: 1,
          launchId: actual.launchId,
          web: stale,
          worker: { ...stale, baselineBackendPids: [] }
        })
      );

      await assert.rejects(
        () => statusLocalProduction({ waitMs: 20 }),
        /stale|not managed/i
      );
    });
  } finally {
    await forceStopGroup(actual.pgid);
  }
});

test("metadata rejects a process record whose PID differs from PGID", async () => {
  const identity = await captureProcessIdentity(process.pid, "node");
  await withTestStorageDir(async () => {
    const runtimeRoot = runtimeDirFor();
    await writeFile(
      envPathFor(),
      "EXTERNAL_ADAPTER_MODE=mock\nALLOW_LAN=false\nDATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1/db\n"
    );
    await writeFile(
      join(runtimeRoot, "processes.json"),
      JSON.stringify({
        version: 1,
        launchId: "launch-123",
        web: { ...identity, pgid: identity.pgid + 1, launchId: "launch-123" },
        worker: {
          ...identity,
          launchId: "launch-123",
          baselineBackendPids: []
        }
      })
    );

    await assert.rejects(
      () => statusLocalProduction({ waitMs: 20 }),
      /PID.*PGID|pid.*pgid/i
    );
  });
});

test("status redacts a leak before reporting stale identity and retains metadata when stop fails", async () => {
  const marker = `tk-runtime-stale-leak-${process.pid}-${Date.now()}`;
  const actual = await spawnManagedDummyIdentity(marker);
  const stale = {
    ...actual,
    startTimeTicks: String(BigInt(actual.startTimeTicks) + 1n)
  };
  try {
    await withTestStorageDir(async () => {
      const runtimeRoot = runtimeDirFor();
      const metadataPath = join(runtimeRoot, "processes.json");
      await writeFile(
        envPathFor(),
        "EXTERNAL_ADAPTER_MODE=mock\nALLOW_LAN=false\nDATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1/db\nAWS_SECRET_ACCESS_KEY=leaked-value\n"
      );
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          launchId: actual.launchId,
          web: stale,
          worker: { ...stale, baselineBackendPids: [] }
        })
      );
      await writeFile(join(runtimeRoot, "web.log"), "credential=leaked-value\n");
      await writeFile(join(runtimeRoot, "worker.log"), "healthy\n");

      await assert.rejects(
        () => statusLocalProduction({ waitMs: 20 }),
        /sensitive value detected.*refusing unmanaged PID/s
      );
      await assert.rejects(() => readFile(join(runtimeRoot, "web.log")), /ENOENT/);
      assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).version, 1);
    });
  } finally {
    await forceStopGroup(actual.pgid);
  }
});

test("stop preserves metadata when either process is unmanaged", async () => {
  const marker = `tk-runtime-unmanaged-${process.pid}-${Date.now()}`;
  const actual = await spawnManagedDummyIdentity(marker);
  try {
    await withTestStorageDir(async () => {
      const runtimeRoot = runtimeDirFor();
      const metadataPath = join(runtimeRoot, "processes.json");
      await writeFile(
        metadataPath,
        JSON.stringify({
          version: 1,
          launchId: actual.launchId,
          web: { ...actual, marker: "wrong-web-marker" },
          worker: {
            ...actual,
            marker: "wrong-worker-marker",
            baselineBackendPids: []
          }
        })
      );

      await assert.rejects(
        () => stopLocalProduction({ waitMs: 50 }),
        /refusing unmanaged PID/
      );
      assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).version, 1);
    });
  } finally {
    await forceStopGroup(actual.pgid);
  }
});

test("failed start reports stop errors and preserves metadata", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-start-cleanup-"));
  const metadataPath = join(repoRoot, "processes.json");
  await writeFile(metadataPath, "{\"version\":1}\n");

  await assert.rejects(
    () => cleanupFailedStart({
      metadata: { version: 1 },
      metadataPath,
      originalError: new Error("readiness failed"),
      stopProcesses: async () => {
        throw new Error("process group survived SIGKILL");
      }
    }),
    /readiness failed.*survived SIGKILL/s
  );
  assert.equal((await readFile(metadataPath, "utf8")).includes("version"), true);
});

test("status stops both process groups and redacts logs on a secret match", async () => {
  const webMarker = `tk-runtime-leak-web-${process.pid}-${Date.now()}`;
  const workerMarker = `tk-runtime-leak-worker-${process.pid}-${Date.now()}`;
  const launchId = `launch-${process.pid}-${Date.now()}`;
  const web = await spawnManagedDummy(webMarker, launchId);
  const worker = await spawnManagedDummy(workerMarker, launchId);
  const webPid = web.pid;
  const workerPid = worker.pid;
  const webIdentity = { ...(await captureProcessIdentity(webPid, webMarker)), launchId };
  const workerIdentity = { ...(await captureProcessIdentity(workerPid, workerMarker)), launchId };
  try {
    await withTestStorageDir(async () => {
      const runtimeRoot = runtimeDirFor();
      await writeFile(
        envPathFor(),
        [
          "EXTERNAL_ADAPTER_MODE=mock",
          "ALLOW_LAN=false",
          "DATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1:5432/tk_workbench_test",
          "EXTENSION_TOKEN=test-fixture-extension-token-value"
        ].join("\n")
      );
      await writeFile(
        join(runtimeRoot, "processes.json"),
        JSON.stringify({
          version: 1,
          launchId,
          web: webIdentity,
          worker: { ...workerIdentity, baselineBackendPids: [] }
        })
      );
      await writeFile(join(runtimeRoot, "web.log"), "test-fixture-extension-token-value\n");
      await writeFile(join(runtimeRoot, "worker.log"), "healthy\n");
      const readyPath = join(runtimeRoot, `worker-ready-${launchId}.json`);
      await writeFile(readyPath, JSON.stringify({ launchId, pid: workerPid }));

      await assert.rejects(
        () => statusLocalProduction({ waitMs: 50 }),
        /sensitive value detected/
      );
      assert.equal(await processIsManaged(webPid, webMarker), false);
      assert.equal(await processIsManaged(workerPid, workerMarker), false);
      await assert.rejects(() => readFile(join(runtimeRoot, "processes.json")), /ENOENT/);
      await assert.rejects(() => readFile(readyPath), /ENOENT/);
      await assert.rejects(() => readFile(join(runtimeRoot, "web.log")), /ENOENT/);
      await assert.rejects(() => readFile(join(runtimeRoot, "worker.log")), /ENOENT/);
    });
  } finally {
    await forceStopGroup(webPid);
    await forceStopGroup(workerPid);
  }
});

test("stop refuses a reused PGID when any group member lacks the launch id", async () => {
  const marker = `tk-runtime-foreign-member-${process.pid}-${Date.now()}`;
  const launchId = `owned-launch-${process.pid}-${Date.now()}`;
  const identity = await spawnManagedDummyIdentity(
    marker,
    `const { spawn } = require("node:child_process");
     const env = { ...process.env }; delete env.TK_RUNTIME_LAUNCH_ID;
     spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", process.argv[1]], { stdio: "ignore", env }).unref();
     setInterval(() => {}, 1000);`,
    launchId
  );
  try {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await assert.rejects(
      () => stopManagedProcess({ ...identity, waitMs: 50 }),
      /launch id|reused process group|unmanaged process group/i
    );
    assert.equal(await groupExists(identity.pgid), true);
  } finally {
    await forceStopGroup(identity.pgid);
  }
});

test("start lock is exclusive and can be safely released", async () => {
  const runtimeRoot = await mkdtemp(join(tmpdir(), "tk-runtime-lock-"));
  const first = await acquireStartLock(runtimeRoot, "launch-one");
  await assert.rejects(
    () => acquireStartLock(runtimeRoot, "launch-two"),
    /start.*already in progress|lock/i
  );
  await first.release();
  const second = await acquireStartLock(runtimeRoot, "launch-two");
  await second.release();
});

// --- Part C: needle tightening ---

test("secretNeedles emits the DATABASE_URL userinfo segment, not the bare password", () => {
  const fixtureUrl = "postgresql://fixture-user:fixture-password@127.0.0.1:5432/tk_workbench_test";
  const needles = secretNeedles({ DATABASE_URL: fixtureUrl });
  assert.ok(
    needles.includes("postgresql://fixture-user:fixture-password@"),
    `expected userinfo prefix in needles, got: ${JSON.stringify(needles)}`
  );
  assert.equal(
    needles.includes("fixture-password"),
    false,
    "bare password must not be a needle — it false-positives on incidental mentions"
  );
  assert.equal(
    needles.includes("fixture-user"),
    false,
    "bare username must not be a needle — only the userinfo segment is secret"
  );
});

test("bare credential substrings in a log do not trigger the sensitive-log fuse", async () => {
  await withTestStorageDir(async () => {
    const runtimeRoot = runtimeDirFor();
    await writeFile(
      envPathFor(),
      [
        "EXTERNAL_ADAPTER_MODE=mock",
        "ALLOW_LAN=false",
        "DATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1:5432/tk_workbench_test"
      ].join("\n")
    );
    await writeFile(join(runtimeRoot, "web.log"), "ok\n");
    await writeFile(
      join(runtimeRoot, "worker.log"),
      [
        "worker: database pool error",
        "pool says: connection refused",
        "log lines mention fixture-user and fixture-password in isolation",
        "and the word postgres in pg error text",
        "but the full userinfo segment never appears whole"
      ].join("\n") + "\n"
    );
    const env = readEnvFile(await readFile(envPathFor(), "utf8"));
    await assert.doesNotReject(() => assertLogsAreRedacted(env));
  });
});

test("full DATABASE_URL userinfo segment in a log DOES trigger the sensitive-log fuse", async () => {
  await withTestStorageDir(async () => {
    const runtimeRoot = runtimeDirFor();
    await writeFile(
      envPathFor(),
      [
        "EXTERNAL_ADAPTER_MODE=mock",
        "ALLOW_LAN=false",
        "DATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1:5432/tk_workbench_test"
      ].join("\n")
    );
    await writeFile(
      join(runtimeRoot, "worker.log"),
      "connection refused for postgresql://fixture-user:fixture-password@127.0.0.1:5432/x\n"
    );
    const env = readEnvFile(await readFile(envPathFor(), "utf8"));
    await assert.rejects(
      () => assertLogsAreRedacted(env),
      (error) => {
        assert.equal(error.code, "SENSITIVE_LOG");
        assert.match(error.message, /worker\.log/);
        return true;
      }
    );
  });
});

// --- Part D: recovery flow ---

test("stopLocalProduction is idempotent: returns cleanly when no metadata exists", async () => {
  await withTestStorageDir(async () => {
    const result = await stopLocalProduction({});
    assert.deepEqual(result, { running: false });
  });
});

test("status fuse deletes web.log and worker.log so subsequent status cannot re-fire", async () => {
  const webMarker = `tk-runtime-logdel-web-${process.pid}-${Date.now()}`;
  const workerMarker = `tk-runtime-logdel-worker-${process.pid}-${Date.now()}`;
  const launchId = `launch-${process.pid}-${Date.now()}`;
  const web = await spawnManagedDummy(webMarker, launchId);
  const worker = await spawnManagedDummy(workerMarker, launchId);
  const webIdentity = { ...(await captureProcessIdentity(web.pid, webMarker)), launchId };
  const workerIdentity = { ...(await captureProcessIdentity(worker.pid, workerMarker)), launchId };
  try {
    await withTestStorageDir(async () => {
      const runtimeRoot = runtimeDirFor();
      await writeFile(
        envPathFor(),
        [
          "EXTERNAL_ADAPTER_MODE=mock",
          "ALLOW_LAN=false",
          "DATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1:5432/tk_workbench_test",
          "EXTENSION_TOKEN=test-fixture-extension-token-value"
        ].join("\n")
      );
      await writeFile(
        join(runtimeRoot, "processes.json"),
        JSON.stringify({
          version: 1,
          launchId,
          web: webIdentity,
          worker: { ...workerIdentity, baselineBackendPids: [] }
        })
      );
      await writeFile(join(runtimeRoot, "web.log"), "test-fixture-extension-token-value\n");
      await writeFile(join(runtimeRoot, "worker.log"), "healthy\n");
      const readyPath = join(runtimeRoot, `worker-ready-${launchId}.json`);
      await writeFile(readyPath, JSON.stringify({ launchId, pid: worker.pid }));

      await assert.rejects(
        () => statusLocalProduction({ waitMs: 50 }),
        /sensitive value detected/
      );
      await assert.rejects(() => readFile(join(runtimeRoot, "web.log")), /ENOENT/);
      await assert.rejects(() => readFile(join(runtimeRoot, "worker.log")), /ENOENT/);
      await assert.rejects(() => readFile(join(runtimeRoot, "processes.json")), /ENOENT/);
      await assert.rejects(() => readFile(readyPath), /ENOENT/);
    });
  } finally {
    await forceStopGroup(web.pid);
    await forceStopGroup(worker.pid);
  }
});

test("status → stop → start → status completes without re-firing the fuse", async () => {
  const webMarker = `tk-runtime-cycle-web-${process.pid}-${Date.now()}`;
  const workerMarker = `tk-runtime-cycle-worker-${process.pid}-${Date.now()}`;
  const launchId = `launch-cycle-${process.pid}-${Date.now()}`;
  const web = await spawnManagedDummy(webMarker, launchId);
  const worker = await spawnManagedDummy(workerMarker, launchId);
  const webIdentity = { ...(await captureProcessIdentity(web.pid, webMarker)), launchId };
  const workerIdentity = { ...(await captureProcessIdentity(worker.pid, workerMarker)), launchId };

  let web2;
  let worker2;
  try {
    await withTestStorageDir(async () => {
      const runtimeRoot = runtimeDirFor();
      await writeFile(
        envPathFor(),
        [
          "EXTERNAL_ADAPTER_MODE=mock",
          "ALLOW_LAN=false",
          "DATABASE_URL=postgresql://fixture-user:fixture-password@127.0.0.1:5432/tk_workbench_test",
          "EXTENSION_TOKEN=test-fixture-extension-token-value"
        ].join("\n")
      );
      await writeFile(
        join(runtimeRoot, "processes.json"),
        JSON.stringify({
          version: 1,
          launchId,
          web: webIdentity,
          worker: { ...workerIdentity, baselineBackendPids: [] }
        })
      );
      await writeFile(join(runtimeRoot, "web.log"), "test-fixture-extension-token-value\n");
      await writeFile(join(runtimeRoot, "worker.log"), "healthy\n");
      const readyPath = join(runtimeRoot, `worker-ready-${launchId}.json`);
      await writeFile(readyPath, JSON.stringify({ launchId, pid: worker.pid }));

      // Step 1: a `status` call detects the leak, fires the fuse, and tears down.
      await assert.rejects(
        () => statusLocalProduction({ waitMs: 50 }),
        /sensitive value detected/
      );

      // Step 2: `stop` after a fuse is idempotent — it does not throw.
      const stopResult = await stopLocalProduction({});
      assert.deepEqual(stopResult, { running: false });

      // Step 3: a fresh launch. Simulate it without invoking the real
      // startLocalProduction (which would require a live pg dependency) by
      // writing fresh metadata + readiness + clean logs.
      const launchId2 = `launch-cycle2-${process.pid}-${Date.now()}`;
      web2 = await spawnManagedDummy(WEB_MARKER, launchId2);
      worker2 = await spawnManagedDummy(WORKER_MARKER, launchId2);
      const webIdentity2 = { ...(await captureProcessIdentity(web2.pid, WEB_MARKER)), launchId: launchId2 };
      const workerIdentity2 = { ...(await captureProcessIdentity(worker2.pid, WORKER_MARKER)), launchId: launchId2 };
      await writeFile(
        join(runtimeRoot, "processes.json"),
        JSON.stringify({
          version: 1,
          launchId: launchId2,
          web: webIdentity2,
          worker: { ...workerIdentity2, baselineBackendPids: [] }
        })
      );
      await writeFile(
        join(runtimeRoot, `worker-ready-${launchId2}.json`),
        JSON.stringify({ launchId: launchId2, pid: worker2.pid })
      );
      await writeFile(join(runtimeRoot, "web.log"), "ok-2\n");
      await writeFile(join(runtimeRoot, "worker.log"), "ok-2\n");

      // Step 4: `status` on the fresh launch must not re-fire the fuse.
      // The dummies in this test do not actually serve HTTP or hold a pg
      // session, so the readiness loop will time out. What matters is that
      // the timeout error is NOT a sensitive-log fuse — i.e. the residual
      // content from the first launch was successfully cleaned up.
      const statusTwo = await statusLocalProduction({ waitMs: 50 }).catch(
        (error) => ({ stage: "status-2", message: error?.message, code: error?.code, name: error?.name })
      );
      assert.notEqual(
        statusTwo?.code,
        "SENSITIVE_LOG",
        `second status must not re-fire the sensitive-log fuse; got: ${JSON.stringify(statusTwo)}`
      );
      assert.doesNotMatch(
        statusTwo?.message ?? "",
        /sensitive value detected/,
        `second status error must not mention sensitive value; got: ${JSON.stringify(statusTwo)}`
      );
    });
  } finally {
    await forceStopGroup(web.pid);
    await forceStopGroup(worker.pid);
    if (web2) await forceStopGroup(web2.pid);
    if (worker2) await forceStopGroup(worker2.pid);
  }
});
