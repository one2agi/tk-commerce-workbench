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
  buildChildEnvironment,
  captureProcessIdentity,
  cleanupFailedStart,
  groupExists,
  processIsManaged,
  readEnvFile,
  startLocalProduction,
  statusLocalProduction,
  stopLocalProduction,
  stopManagedProcess,
  writeProcessMetadata
} from "../local-production-runtime.mjs";

async function waitForManagedProcess(pid, marker) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await processIsManaged(pid, marker)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`dummy process ${pid} did not expose marker ${marker}`);
}

test("runtime health endpoint returns the launch token only to a matching probe", async () => {
  const handler = createRuntimeHealthHandler({ healthToken: "launch-token" });
  const unauthorized = await handler(
    new Request("http://127.0.0.1/api/runtime-health")
  );
  assert.equal(unauthorized.status, 404);

  const authorized = await handler(
    new Request("http://127.0.0.1/api/runtime-health", {
      headers: { "x-tk-runtime-health-token": "launch-token" }
    })
  );
  assert.equal(authorized.status, 200);
  assert.deepEqual(await authorized.json(), { token: "launch-token" });
});

async function spawnManagedDummy(marker) {
  const child = spawn(
    process.execPath,
    ["-e", "setInterval(() => {}, 1000)", marker],
    { detached: true, stdio: "ignore" }
  );
  child.unref();
  await waitForManagedProcess(child.pid, marker);
  return child.pid;
}

async function spawnManagedDummyIdentity(
  marker,
  source = "setInterval(() => {}, 1000)"
) {
  const child = spawn(process.execPath, ["-e", source, marker], {
    detached: true,
    stdio: "ignore"
  });
  child.unref();
  await waitForManagedProcess(child.pid, marker);
  return captureProcessIdentity(child.pid, marker);
}

async function forceStopGroup(pid) {
  try {
    process.kill(-pid, "SIGKILL");
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
}

test("env parser treats values as data rather than shell", () => {
  assert.deepEqual(readEnvFile("SAFE=$(touch /tmp/never-run)\nMODE=mock\n"), {
    SAFE: "$(touch /tmp/never-run)",
    MODE: "mock"
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
      runtimeToken: "runtime-token",
      hostEnv: {
        PATH: "/usr/bin",
        HOME: "/tmp/home",
        LANG: "C.UTF-8",
        AWS_SECRET_ACCESS_KEY: "ambient-secret",
        NODE_OPTIONS: "--inspect"
      }
    }
  );

  assert.deepEqual(childEnv, {
    PATH: "/usr/bin",
    HOME: "/tmp/home",
    LANG: "C.UTF-8",
    DATABASE_URL: "postgresql://local",
    APP_SECRET: "configured-secret",
    NODE_ENV: "production",
    TK_RUNTIME_HEALTH_TOKEN: "runtime-token"
  });
});

test("process metadata uses exclusive creation", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-metadata-"));
  const metadataPath = join(repoRoot, "processes.json");
  const metadata = {
    version: 1,
    healthToken: "health-token",
    web: { pid: 101, pgid: 101, startTimeTicks: "1001", marker: "web-marker" },
    worker: {
      pid: 202,
      pgid: 202,
      startTimeTicks: "2002",
      marker: "worker-marker",
      applicationName: "worker-unique"
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
    () => stopManagedProcess({ ...identity, marker: "definitely-not-present" }),
    new RegExp(`refusing unmanaged PID ${process.pid}`)
  );
});

test("stop terminates a managed dummy process group within the bound", async () => {
  const marker = `tk-runtime-stop-${process.pid}-${Date.now()}`;
  const pid = await spawnManagedDummy(marker);
  const identity = await captureProcessIdentity(pid, marker);

  try {
    await stopManagedProcess({ ...identity, waitMs: 1_000 });
    assert.equal(await processIsManaged(pid, marker), false);
  } finally {
    await forceStopGroup(pid);
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

test("start rejects a missing env before spawning anything", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-no-env-"));
  await assert.rejects(() => startLocalProduction({ repoRoot }), /\.env.*required/i);
});

test("status rejects stale process metadata", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-status-"));
  const runtimeRoot = join(repoRoot, "data/runtime");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    join(repoRoot, ".env"),
    "EXTERNAL_ADAPTER_MODE=mock\nALLOW_LAN=false\nDATABASE_URL=postgresql://postgres:password@127.0.0.1/db\n"
  );
  await writeFile(
    join(runtimeRoot, "processes.json"),
    JSON.stringify({
      version: 1,
      healthToken: "health-token",
      web: {
        pid: 2 ** 31 - 1,
        pgid: 2 ** 31 - 1,
        startTimeTicks: "1001",
        marker: "stale-web"
      },
      worker: {
        pid: 2 ** 31 - 2,
        pgid: 2 ** 31 - 2,
        startTimeTicks: "2002",
        marker: "stale-worker",
        applicationName: "worker-unique"
      }
    })
  );

  await assert.rejects(
    () => statusLocalProduction({ repoRoot, waitMs: 50 }),
    /stale|not managed/i
  );
});

test("status rejects a reused PID even when its command marker matches", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-reused-pid-"));
  const runtimeRoot = join(repoRoot, "data/runtime");
  const actual = await captureProcessIdentity(process.pid, "node");
  const stale = {
    ...actual,
    startTimeTicks: String(BigInt(actual.startTimeTicks) + 1n)
  };
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    join(repoRoot, ".env"),
    "EXTERNAL_ADAPTER_MODE=mock\nALLOW_LAN=false\nDATABASE_URL=postgresql://postgres:password@127.0.0.1/db\n"
  );
  await writeFile(
    join(runtimeRoot, "processes.json"),
    JSON.stringify({
      version: 1,
      healthToken: "health-token",
      web: stale,
      worker: { ...stale, applicationName: "worker-unique" }
    })
  );

  await assert.rejects(
    () => statusLocalProduction({ repoRoot, waitMs: 20 }),
    /stale|not managed/i
  );
});

test("status redacts a leak before reporting stale identity and retains metadata when stop fails", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-stale-leak-"));
  const runtimeRoot = join(repoRoot, "data/runtime");
  const actual = await captureProcessIdentity(process.pid, "node");
  const stale = {
    ...actual,
    startTimeTicks: String(BigInt(actual.startTimeTicks) + 1n)
  };
  const metadataPath = join(runtimeRoot, "processes.json");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    join(repoRoot, ".env"),
    "EXTERNAL_ADAPTER_MODE=mock\nALLOW_LAN=false\nDATABASE_URL=postgresql://postgres:password@127.0.0.1/db\nAWS_SECRET_ACCESS_KEY=leaked-value\n"
  );
  await writeFile(
    metadataPath,
    JSON.stringify({
      version: 1,
      healthToken: "health-token",
      web: stale,
      worker: { ...stale, applicationName: "worker-unique" }
    })
  );
  await writeFile(join(runtimeRoot, "web.log"), "credential=leaked-value\n");
  await writeFile(join(runtimeRoot, "worker.log"), "healthy\n");

  await assert.rejects(
    () => statusLocalProduction({ repoRoot, waitMs: 20 }),
    /sensitive value detected.*refusing unmanaged PID/s
  );
  assert.doesNotMatch(
    await readFile(join(runtimeRoot, "web.log"), "utf8"),
    /leaked-value/
  );
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).version, 1);
});

test("stop preserves metadata when either process is unmanaged", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-refuse-"));
  const runtimeRoot = join(repoRoot, "data/runtime");
  const metadataPath = join(runtimeRoot, "processes.json");
  await mkdir(runtimeRoot, { recursive: true });
  const actual = await captureProcessIdentity(process.pid, "node");
  await writeFile(
    metadataPath,
    JSON.stringify({
      version: 1,
      healthToken: "health-token",
      web: { ...actual, marker: "wrong-web-marker" },
      worker: {
        ...actual,
        marker: "wrong-worker-marker",
        applicationName: "worker-unique"
      }
    })
  );

  await assert.rejects(
    () => stopLocalProduction({ repoRoot, waitMs: 50 }),
    /refusing unmanaged PID/
  );
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).version, 1);
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
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-leak-"));
  const runtimeRoot = join(repoRoot, "data/runtime");
  const webMarker = `tk-runtime-leak-web-${process.pid}-${Date.now()}`;
  const workerMarker = `tk-runtime-leak-worker-${process.pid}-${Date.now()}`;
  const webPid = await spawnManagedDummy(webMarker);
  const workerPid = await spawnManagedDummy(workerMarker);
  const webIdentity = await captureProcessIdentity(webPid, webMarker);
  const workerIdentity = await captureProcessIdentity(workerPid, workerMarker);
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    join(repoRoot, ".env"),
    [
      "EXTERNAL_ADAPTER_MODE=mock",
      "ALLOW_LAN=false",
      "DATABASE_URL=postgresql://postgres:runtime-password@127.0.0.1:5432/tk_workbench",
      "EXTENSION_TOKEN=runtime-secret-token"
    ].join("\n")
  );
  await writeFile(
    join(runtimeRoot, "processes.json"),
    JSON.stringify({
      version: 1,
      healthToken: "health-token",
      web: webIdentity,
      worker: { ...workerIdentity, applicationName: "worker-unique" }
    })
  );
  await writeFile(join(runtimeRoot, "web.log"), "health-token\n");
  await writeFile(join(runtimeRoot, "worker.log"), "healthy\n");

  try {
    await assert.rejects(
      () => statusLocalProduction({ repoRoot, waitMs: 50 }),
      /sensitive value detected/
    );
    assert.equal(await processIsManaged(webPid, webMarker), false);
    assert.equal(await processIsManaged(workerPid, workerMarker), false);
    await assert.rejects(() => readFile(join(runtimeRoot, "processes.json")), /ENOENT/);
    assert.doesNotMatch(await readFile(join(runtimeRoot, "web.log"), "utf8"), /health-token/);
  } finally {
    await forceStopGroup(webPid);
    await forceStopGroup(workerPid);
  }
});
