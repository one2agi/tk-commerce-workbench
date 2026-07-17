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

import {
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

test("process metadata uses exclusive creation", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-metadata-"));
  const metadataPath = join(repoRoot, "processes.json");
  const metadata = {
    version: 1,
    web: { pid: 101, marker: "web-marker" },
    worker: { pid: 202, marker: "worker-marker" }
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

test("stop refuses a live PID whose command line lacks the marker", async () => {
  await assert.rejects(
    () => stopManagedProcess({ pid: process.pid, marker: "definitely-not-present" }),
    new RegExp(`refusing unmanaged PID ${process.pid}`)
  );
});

test("stop terminates a managed dummy process group within the bound", async () => {
  const marker = `tk-runtime-stop-${process.pid}-${Date.now()}`;
  const pid = await spawnManagedDummy(marker);

  try {
    await stopManagedProcess({ pid, marker, waitMs: 1_000 });
    assert.equal(await processIsManaged(pid, marker), false);
  } finally {
    await forceStopGroup(pid);
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
    join(runtimeRoot, "processes.json"),
    JSON.stringify({
      version: 1,
      web: { pid: 2 ** 31 - 1, marker: "stale-web" },
      worker: { pid: 2 ** 31 - 2, marker: "stale-worker" }
    })
  );

  await assert.rejects(
    () => statusLocalProduction({ repoRoot, waitMs: 50 }),
    /stale|not managed/i
  );
});

test("stop preserves metadata when either process is unmanaged", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-refuse-"));
  const runtimeRoot = join(repoRoot, "data/runtime");
  const metadataPath = join(runtimeRoot, "processes.json");
  await mkdir(runtimeRoot, { recursive: true });
  await writeFile(
    metadataPath,
    JSON.stringify({
      version: 1,
      web: { pid: process.pid, marker: "wrong-web-marker" },
      worker: { pid: process.pid, marker: "wrong-worker-marker" }
    })
  );

  await assert.rejects(
    () => stopLocalProduction({ repoRoot, waitMs: 50 }),
    /refusing unmanaged PID/
  );
  assert.equal(JSON.parse(await readFile(metadataPath, "utf8")).version, 1);
});

test("status stops both process groups and redacts logs on a secret match", async () => {
  const repoRoot = await mkdtemp(join(tmpdir(), "tk-runtime-leak-"));
  const runtimeRoot = join(repoRoot, "data/runtime");
  const webMarker = `tk-runtime-leak-web-${process.pid}-${Date.now()}`;
  const workerMarker = `tk-runtime-leak-worker-${process.pid}-${Date.now()}`;
  const webPid = await spawnManagedDummy(webMarker);
  const workerPid = await spawnManagedDummy(workerMarker);
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
      web: { pid: webPid, marker: webMarker },
      worker: { pid: workerPid, marker: workerMarker }
    })
  );
  await writeFile(join(runtimeRoot, "web.log"), "Authorization: Bearer runtime-secret-token\n");
  await writeFile(join(runtimeRoot, "worker.log"), "healthy\n");

  try {
    await assert.rejects(
      () => statusLocalProduction({ repoRoot, waitMs: 50 }),
      /sensitive value detected/
    );
    assert.equal(await processIsManaged(webPid, webMarker), false);
    assert.equal(await processIsManaged(workerPid, workerMarker), false);
    await assert.rejects(() => readFile(join(runtimeRoot, "processes.json")), /ENOENT/);
    assert.doesNotMatch(await readFile(join(runtimeRoot, "web.log"), "utf8"), /Authorization|runtime-secret-token/);
  } finally {
    await forceStopGroup(webPid);
    await forceStopGroup(workerPid);
  }
});
