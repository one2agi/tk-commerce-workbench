import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createRequire } from "node:module";
import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_URL = "http://127.0.0.1:3000/";
const WEB_MARKER = "pnpm --filter @tk/web start";
const WORKER_MARKER = "pnpm --filter @tk/worker start";
const WORKER_APPLICATION_NAME = "tk-workbench-local-worker";
const INHERITED_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TERM"
];

export function readEnvFile(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("\0")) throw new Error("env contains NUL");
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("invalid env assignment");
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1);
    if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`);
    if (Object.hasOwn(result, key)) throw new Error(`duplicate env key: ${key}`);
    result[key] = value;
  }
  return result;
}

export function buildChildEnvironment(
  env,
  { launchId, hostEnv = process.env }
) {
  const inherited = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    if (hostEnv[key] !== undefined) inherited[key] = hostEnv[key];
  }
  return {
    ...inherited,
    ...env,
    NODE_ENV: "production",
    TK_RUNTIME_LAUNCH_ID: launchId
  };
}

export function buildWorkerCommand() {
  return {
    command: "env",
    args: [
      `PGAPPNAME=${WORKER_APPLICATION_NAME}`,
      "pnpm",
      "--filter",
      "@tk/worker",
      "start"
    ]
  };
}

export function hasNewWorkerBackend(baselineBackendPids, currentBackendPids) {
  const baseline = new Set(baselineBackendPids);
  return currentBackendPids.some((pid) => !baseline.has(pid));
}

export function buildWorkerProbeClientConfig(connectionString) {
  return {
    connectionString,
    connectionTimeoutMillis: 1_000,
    application_name: "tk-workbench-local-runtime-probe"
  };
}

export async function writeProcessMetadata(metadataPath, metadata) {
  try {
    await writeFile(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(`process metadata already exists: ${metadataPath}`);
    }
    throw error;
  }
}

export async function processIsManaged(pid, marker) {
  if (typeof pid === "object" && pid !== null) {
    const expected = pid;
    try {
      const actual = await captureProcessIdentity(
        expected.pid,
        expected.marker,
        expected.launchId
      );
      return actual.pgid === expected.pgid && actual.startTimeTicks === expected.startTimeTicks;
    } catch {
      return false;
    }
  }
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.split("\0").join(" ").includes(marker);
  } catch {
    return false;
  }
}

async function readLinuxProcessState(pid) {
  const statText = await readFile(`/proc/${pid}/stat`, "utf8");
  const commandEnd = statText.lastIndexOf(")");
  if (commandEnd < 0) throw new Error(`invalid /proc/${pid}/stat`);
  const fields = statText.slice(commandEnd + 2).trim().split(/\s+/);
  const state = fields[0];
  const pgid = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (!Number.isSafeInteger(pgid) || pgid < 2 || !/^\d+$/.test(startTimeTicks ?? "")) {
    throw new Error(`invalid /proc/${pid}/stat identity`);
  }
  return { pgid, startTimeTicks, state };
}

async function processHasLaunchId(pid, launchId) {
  try {
    const entries = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
    return entries.includes(`TK_RUNTIME_LAUNCH_ID=${launchId}`);
  } catch {
    return false;
  }
}

async function ownedGroupMembers(pgid, launchId) {
  const entries = await readdir("/proc", { withFileTypes: true });
  const members = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    try {
      const state = await readLinuxProcessState(pid);
      if (state.pgid !== pgid || state.state === "Z") continue;
      if (!(await processHasLaunchId(pid, launchId))) {
        throw new Error(`refusing reused process group ${pgid}: member ${pid} lacks launch id`);
      }
      members.push(pid);
    } catch (error) {
      if (/refusing reused process group/.test(error.message)) throw error;
      // Processes can exit while /proc is being scanned.
    }
  }
  return members;
}

export async function captureProcessIdentity(pid, marker, launchId) {
  if (!Number.isSafeInteger(pid) || pid < 2 || typeof marker !== "string" || !marker) {
    throw new Error("invalid process identity request");
  }
  const commandLine = (await readFile(`/proc/${pid}/cmdline`, "utf8"))
    .split("\0")
    .join(" ");
  if (!commandLine.includes(marker)) throw new Error(`PID ${pid} does not contain marker`);
  if (launchId && !(await processHasLaunchId(pid, launchId))) {
    throw new Error(`PID ${pid} does not contain launch id`);
  }
  const { pgid, startTimeTicks } = await readLinuxProcessState(pid);
  return { pid, pgid, startTimeTicks, marker, ...(launchId ? { launchId } : {}) };
}

export async function groupExists(pgid) {
  if (!Number.isSafeInteger(pgid) || pgid < 2) return false;
  try {
    const entries = await readdir("/proc", { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
      try {
        if ((await readLinuxProcessState(Number(entry.name))).pgid === pgid) return true;
      } catch {
        // Processes can exit while /proc is being scanned.
      }
    }
    return false;
  } catch {
    try {
      process.kill(-pgid, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  }
}

export async function stopManagedProcess({
  pid,
  pgid,
  startTimeTicks,
  marker,
  launchId,
  waitMs = 10_000
}) {
  if (typeof launchId !== "string" || !launchId) {
    throw new Error("managed process launch id is required");
  }
  const identity = { pid, pgid, startTimeTicks, marker };
  let leaderExists = true;
  try {
    const actual = await captureProcessIdentity(pid, marker, launchId);
    if (actual.pgid !== pgid || actual.startTimeTicks !== startTimeTicks) {
      throw new Error(`refusing unmanaged PID ${pid}`);
    }
  } catch (error) {
    try {
      await stat(`/proc/${pid}`);
    } catch (statError) {
      if (statError?.code === "ENOENT") leaderExists = false;
      else throw error;
    }
    if (leaderExists) throw new Error(`refusing unmanaged PID ${pid}`);
  }

  if ((await ownedGroupMembers(pgid, launchId)).length === 0) return;
  process.kill(-identity.pgid, "SIGTERM");
  if (await waitForGroupExit(pgid, launchId, waitMs)) return;
  await ownedGroupMembers(pgid, launchId);
  process.kill(-identity.pgid, "SIGKILL");
  if (await waitForGroupExit(pgid, launchId, waitMs)) return;
  throw new Error(`process group ${pgid} survived SIGKILL`);
}

export async function cleanupProvisionalProcess({
  pid,
  pgid,
  marker,
  launchId,
  waitMs = 10_000
}) {
  if (!Number.isSafeInteger(pid) || pid < 2 || pid !== pgid || !marker || !launchId) {
    throw new Error("invalid provisional process metadata: PID must equal PGID");
  }
  try {
    await stat(`/proc/${pid}`);
    const commandLine = (await readFile(`/proc/${pid}/cmdline`, "utf8"))
      .split("\0")
      .join(" ");
    if (!commandLine.includes(marker)) throw new Error(`refusing unmanaged PID ${pid}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if ((await ownedGroupMembers(pgid, launchId)).length === 0) return;
  process.kill(-pgid, "SIGTERM");
  if (await waitForGroupExit(pgid, launchId, waitMs)) return;
  await ownedGroupMembers(pgid, launchId);
  process.kill(-pgid, "SIGKILL");
  if (await waitForGroupExit(pgid, launchId, waitMs)) return;
  throw new Error(`provisional process group ${pgid} survived SIGKILL`);
}

function validateRecoveryRecord(record) {
  if (
    !record ||
    !Number.isSafeInteger(record.pid) ||
    record.pid < 2 ||
    record.pid !== record.pgid ||
    typeof record.marker !== "string" ||
    !record.marker ||
    typeof record.launchId !== "string" ||
    !record.launchId
  ) {
    throw new Error("invalid recovery metadata: PID must equal PGID");
  }
  if (
    record.startTimeTicks !== undefined &&
    (typeof record.startTimeTicks !== "string" || !/^\d+$/.test(record.startTimeTicks))
  ) {
    throw new Error("invalid recovery process start time");
  }
  return record.startTimeTicks === undefined
    ? { pid: record.pid, pgid: record.pgid, marker: record.marker, launchId: record.launchId }
    : {
        pid: record.pid,
        pgid: record.pgid,
        startTimeTicks: record.startTimeTicks,
        marker: record.marker,
        launchId: record.launchId
      };
}

export async function cleanupSpawnFailure({
  records,
  metadataPath,
  originalError,
  stopRecord = async (record) => record.startTimeTicks === undefined
    ? cleanupProvisionalProcess(record)
    : stopManagedProcess(record)
}) {
  const failedRecords = [];
  const cleanupErrors = [];
  for (const rawRecord of records) {
    const record = validateRecoveryRecord(rawRecord);
    try {
      await stopRecord(record);
    } catch (error) {
      failedRecords.push(record);
      cleanupErrors.push(error);
    }
  }
  if (failedRecords.length > 0) {
    try {
      await writeProcessMetadata(metadataPath, {
        version: 1,
        state: "recovery",
        launchId: failedRecords[0].launchId,
        records: failedRecords
      });
    } catch (metadataError) {
      cleanupErrors.push(metadataError);
    }
    throw new AggregateError(
      [originalError, ...cleanupErrors],
      [originalError, ...cleanupErrors].map((error) => error.message).join("; ")
    );
  }
  throw originalError;
}

async function waitForGroupExit(pgid, launchId, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    if ((await ownedGroupMembers(pgid, launchId)).length === 0) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, waitMs))));
  } while (Date.now() < deadline);
  return (await ownedGroupMembers(pgid, launchId)).length === 0;
}

function metadataPathFor(repoRoot) {
  return join(repoRoot, "data/runtime/processes.json");
}

function workerReadyPathFor(repoRoot, launchId) {
  if (!/^[A-Za-z0-9_-]+$/.test(launchId)) throw new Error("invalid runtime launch id");
  return join(repoRoot, `data/runtime/worker-ready-${launchId}.json`);
}

export async function acquireStartLock(runtimeRoot, launchId) {
  const lockPath = join(runtimeRoot, "start.lock");
  let handle;
  let created = false;
  try {
    handle = await open(lockPath, "wx", 0o600);
    created = true;
    await handle.writeFile(`${JSON.stringify({ launchId, pid: process.pid })}\n`);
  } catch (error) {
    const cleanupErrors = [];
    await handle?.close().catch((cleanupError) => cleanupErrors.push(cleanupError));
    if (created) {
      await unlink(lockPath).catch((cleanupError) => cleanupErrors.push(cleanupError));
    }
    if (error?.code === "EEXIST") {
      throw new Error("local production start is already in progress (start lock exists)");
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        [error, ...cleanupErrors].map((item) => item.message).join("; ")
      );
    }
    throw error;
  }
  let released = false;
  return {
    async release() {
      if (released) return;
      released = true;
      let closeError;
      try {
        await handle.close();
      } catch (error) {
        closeError = error;
      } finally {
        await unlink(lockPath).catch((error) => {
          if (error?.code !== "ENOENT") throw error;
        });
      }
      if (closeError) throw closeError;
    }
  };
}

function validateProcessRecord(value, label, launchId) {
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 2 ||
    !Number.isSafeInteger(value.pgid) ||
    value.pgid < 2 ||
    typeof value.startTimeTicks !== "string" ||
    !/^\d+$/.test(value.startTimeTicks) ||
    typeof value.marker !== "string" ||
    value.marker.length === 0 ||
    value.launchId !== launchId
  ) {
    throw new Error(`invalid ${label} process metadata`);
  }
  if (value.pid !== value.pgid) {
    throw new Error(`invalid ${label} process metadata: PID must equal PGID`);
  }
  return {
    pid: value.pid,
    pgid: value.pgid,
    startTimeTicks: value.startTimeTicks,
    marker: value.marker,
    launchId: value.launchId
  };
}

async function readProcessMetadata(repoRoot) {
  const metadataPath = metadataPathFor(repoRoot);
  let metadata;
  try {
    metadata = JSON.parse(await readFile(metadataPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error(`process metadata is required: ${metadataPath}`);
    }
    throw new Error(`invalid process metadata: ${error.message}`);
  }
  if (metadata?.version !== 1) throw new Error("unsupported process metadata version");
  if (metadata.state === "recovery") {
    if (!Array.isArray(metadata.records) || metadata.records.length === 0) {
      throw new Error("invalid recovery process metadata");
    }
    if (typeof metadata.launchId !== "string" || !metadata.launchId) {
      throw new Error("invalid recovery launch id metadata");
    }
    if (metadata.records.some((record) => record?.launchId !== metadata.launchId)) {
      throw new Error("recovery records do not match launch id");
    }
    return {
      version: 1,
      state: "recovery",
      launchId: metadata.launchId,
      records: metadata.records.map(validateRecoveryRecord)
    };
  }
  if (typeof metadata.launchId !== "string" || !metadata.launchId) {
    throw new Error("invalid runtime launch id metadata");
  }
  if (
    !Array.isArray(metadata.worker?.baselineBackendPids) ||
    metadata.worker.baselineBackendPids.some((pid) => !Number.isSafeInteger(pid) || pid < 1)
  ) {
    throw new Error("invalid worker baseline backend PID metadata");
  }
  return {
    version: 1,
    launchId: metadata.launchId,
    web: validateProcessRecord(metadata.web, "web", metadata.launchId),
    worker: {
      ...validateProcessRecord(metadata.worker, "worker", metadata.launchId),
      baselineBackendPids: [...new Set(metadata.worker.baselineBackendPids)]
    }
  };
}

async function readRequiredEnv(repoRoot) {
  const envPath = join(repoRoot, ".env");
  try {
    return readEnvFile(await readFile(envPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`repository .env is required: ${envPath}`);
    throw error;
  }
}

function assertSafeRuntimeEnv(env) {
  if (env.EXTERNAL_ADAPTER_MODE !== "mock") {
    throw new Error("EXTERNAL_ADAPTER_MODE must equal mock");
  }
  if (env.ALLOW_LAN !== "false") throw new Error("ALLOW_LAN must equal false");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is required");
}

async function assertProductionBuild(repoRoot) {
  const buildIdPath = join(repoRoot, "apps/web/.next/BUILD_ID");
  try {
    const buildId = (await readFile(buildIdPath, "utf8")).trim();
    if (!buildId) throw new Error("BUILD_ID is empty");
    const buildDirectory = await stat(join(repoRoot, "apps/web/.next"));
    if (!buildDirectory.isDirectory()) throw new Error(".next is not a directory");
  } catch (error) {
    throw new Error(`healthy production build is required at ${buildIdPath}: ${error.message}`);
  }
}

function spawnDetached(command, args, options) {
  return new Promise((resolveSpawn, rejectSpawn) => {
    const child = spawn(command, args, { ...options, detached: true });
    child.once("error", rejectSpawn);
    child.once("spawn", () => {
      child.removeListener("error", rejectSpawn);
      child.unref();
      resolveSpawn(child);
    });
  });
}

async function waitForProcessIdentity(pid, marker, waitMs = 2_000, launchId) {
  const deadline = Date.now() + waitMs;
  let lastError;
  do {
    try {
      return await captureProcessIdentity(pid, marker, launchId);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  } while (Date.now() < deadline);
  throw new Error(`PID ${pid} did not expose its runtime marker: ${lastError?.message}`);
}

export function secretNeedles(env) {
  const values = Object.entries(env)
    .filter(([key, value]) =>
      /SECRET|TOKEN|PASSWORD|PASS_PHRASE|API[_-]?KEY|PRIVATE[_-]?KEY|CREDENTIAL|AUTH/i.test(key) && value
    )
    .map(([, value]) => value);
  try {
    const password = new URL(env.DATABASE_URL).password;
    if (password) values.push(decodeURIComponent(password));
  } catch {
    // PostgreSQL reports malformed connection strings during the readiness check.
  }
  return [...new Set(["Authorization", "APP Secret", ...values])];
}

async function assertLogsAreRedacted(repoRoot, env) {
  const runtimeRoot = join(repoRoot, "data/runtime");
  const needles = secretNeedles(env);
  for (const name of ["web.log", "worker.log"]) {
    let contents;
    try {
      contents = await readFile(join(runtimeRoot, name), "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const leakedNeedle = needles.find((needle) => contents.includes(needle));
    if (leakedNeedle) {
      const error = new Error(`sensitive value detected in ${name}`);
      error.code = "SENSITIVE_LOG";
      throw error;
    }
  }
}

async function redactSensitiveLogs(repoRoot, env) {
  const runtimeRoot = join(repoRoot, "data/runtime");
  const needles = secretNeedles(env);
  for (const name of ["web.log", "worker.log"]) {
    const logPath = join(runtimeRoot, name);
    let contents;
    try {
      contents = await readFile(logPath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    const redacted = needles.reduce(
      (safeContents, needle) => safeContents.split(needle).join("[REDACTED]"),
      contents
    );
    if (redacted !== contents) await writeFile(logPath, redacted, { mode: 0o600 });
  }
}

async function webIsReady(launchId) {
  try {
    const rootResponse = await fetch(WEB_URL, { signal: AbortSignal.timeout(1_000) });
    await rootResponse.body?.cancel();
    if (rootResponse.status < 200 || rootResponse.status >= 300) return false;
    const healthResponse = await fetch(`${WEB_URL}api/runtime-health`, {
      signal: AbortSignal.timeout(1_000)
    });
    if (!healthResponse.ok) return false;
    return (await healthResponse.json()).launchId === launchId;
  } catch {
    return false;
  }
}

async function queryWorkerBackendPids(repoRoot, connectionString) {
  let client;
  try {
    const requireFromDb = createRequire(join(repoRoot, "packages/db/package.json"));
    const { Client } = requireFromDb("pg");
    client = new Client(buildWorkerProbeClientConfig(connectionString));
    await client.connect();
    const result = await client.query(
      "SELECT pid FROM pg_stat_activity WHERE application_name = $1",
      [WORKER_APPLICATION_NAME]
    );
    return result.rows.map((row) => Number(row.pid)).filter(Number.isSafeInteger);
  } finally {
    await client?.end().catch(() => {});
  }
}

async function workerIsReady(repoRoot, launchId, worker) {
  try {
    const proof = JSON.parse(await readFile(workerReadyPathFor(repoRoot, launchId), "utf8"));
    if (proof?.launchId !== launchId || !Number.isSafeInteger(proof.pid) || proof.pid < 2) {
      return false;
    }
    const state = await readLinuxProcessState(proof.pid);
    return state.pgid === worker.pgid && await processHasLaunchId(proof.pid, launchId);
  } catch {
    return false;
  }
}

async function assertBothProcessesManaged(metadata) {
  if (!(await processIsManaged(metadata.web))) {
    throw new Error(`web PID ${metadata.web.pid} is stale or not managed`);
  }
  if (!(await processIsManaged(metadata.worker))) {
    throw new Error(`worker PID ${metadata.worker.pid} is stale or not managed`);
  }
}

async function inspectLogsOrStop(metadata, repoRoot, env) {
  try {
    await assertLogsAreRedacted(repoRoot, env);
  } catch (error) {
    if (error?.code !== "SENSITIVE_LOG") throw error;
    let stopError;
    try {
      await stopBoth(metadata, 10_000);
      await unlink(metadataPathFor(repoRoot));
      await unlink(workerReadyPathFor(repoRoot, metadata.launchId)).catch((unlinkError) => {
        if (unlinkError?.code !== "ENOENT") throw unlinkError;
      });
    } catch (caught) {
      stopError = caught;
    }
    await redactSensitiveLogs(repoRoot, env);
    if (stopError) {
      throw new AggregateError([error, stopError], `${error.message}; ${stopError.message}`);
    }
    throw error;
  }
}

export async function statusLocalProduction({ repoRoot, waitMs = 60_000 }) {
  const metadata = await readProcessMetadata(repoRoot);
  if (metadata.state === "recovery") {
    throw new Error("startup recovery metadata requires manual cleanup");
  }
  const env = await readRequiredEnv(repoRoot);
  assertSafeRuntimeEnv(env);
  const childEnv = buildChildEnvironment(env, { launchId: metadata.launchId });
  await inspectLogsOrStop(metadata, repoRoot, childEnv);
  await assertBothProcessesManaged(metadata);

  const deadline = Date.now() + waitMs;
  while (true) {
    await inspectLogsOrStop(metadata, repoRoot, childEnv);
    await assertBothProcessesManaged(metadata);
    const [webReady, workerReady] = await Promise.all([
      webIsReady(metadata.launchId),
      workerIsReady(repoRoot, metadata.launchId, metadata.worker)
    ]);
    if (webReady && workerReady) {
      await inspectLogsOrStop(metadata, repoRoot, childEnv);
      await assertBothProcessesManaged(metadata);
      return { running: true, webUrl: WEB_URL, web: metadata.web, worker: metadata.worker };
    }
    if (Date.now() >= deadline) {
      throw new Error("local production did not become ready before the deadline");
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
}

async function stopBoth(metadata, waitMs) {
  const errors = [];
  for (const record of [metadata.worker, metadata.web]) {
    try {
      await stopManagedProcess({ ...record, waitMs });
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
}

export async function cleanupFailedStart({
  metadata,
  metadataPath,
  originalError,
  stopProcesses = (records) => stopBoth(records, 10_000),
  removeMetadata = unlink
}) {
  try {
    await stopProcesses(metadata);
  } catch (stopError) {
    throw new AggregateError(
      [originalError, stopError],
      `${originalError.message}; ${stopError.message}`
    );
  }
  try {
    await removeMetadata(metadataPath);
  } catch (removeError) {
    if (removeError?.code !== "ENOENT") {
      throw new AggregateError(
        [originalError, removeError],
        `${originalError.message}; ${removeError.message}`
      );
    }
  }
  throw originalError;
}

export async function stopLocalProduction({ repoRoot, waitMs = 10_000 }) {
  const metadata = await readProcessMetadata(repoRoot);
  if (metadata.state === "recovery") {
    if (metadata.records.some((record) => record.startTimeTicks === undefined)) {
      throw new Error("unverified provisional PGID: manual cleanup required");
    }
    const errors = [];
    for (const record of metadata.records) {
      try {
        await stopManagedProcess({ ...record, waitMs });
      } catch (error) {
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, errors.map((error) => error.message).join("; "));
    }
    await unlink(metadataPathFor(repoRoot));
    await unlink(workerReadyPathFor(repoRoot, metadata.launchId)).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    return { running: false, recovered: true };
  }
  await stopBoth(metadata, waitMs);
  await unlink(metadataPathFor(repoRoot));
  await unlink(workerReadyPathFor(repoRoot, metadata.launchId)).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
  return { running: false };
}

export async function startLocalProduction({ repoRoot, waitMs = 60_000 }) {
  const env = await readRequiredEnv(repoRoot);
  assertSafeRuntimeEnv(env);
  await assertProductionBuild(repoRoot);

  const runtimeRoot = join(repoRoot, "data/runtime");
  const metadataPath = metadataPathFor(repoRoot);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  const launchId = randomBytes(24).toString("base64url");
  const startLock = await acquireStartLock(runtimeRoot, launchId);
  const childEnv = {
    ...buildChildEnvironment(env, { launchId }),
    TK_WORKER_READY_PATH: workerReadyPathFor(repoRoot, launchId)
  };
  let webLog;
  let workerLog;
  let web;
  let worker;
  let webIdentity;
  let workerIdentity;
  let metadata;
  let metadataWritten = false;
  try {
    try {
      const existing = await readProcessMetadata(repoRoot);
      if (existing.state === "recovery") {
        throw new Error("startup recovery metadata requires manual cleanup");
      }
      await assertBothProcessesManaged(existing);
      throw new Error("local production is already running");
    } catch (error) {
      if (!/process metadata is required/.test(error.message)) throw error;
    }
    const baselineBackendPids = await queryWorkerBackendPids(repoRoot, env.DATABASE_URL);
    webLog = await open(join(runtimeRoot, "web.log"), "a", 0o600);
    workerLog = await open(join(runtimeRoot, "worker.log"), "a", 0o600);
    web = await spawnDetached("pnpm", ["--filter", "@tk/web", "start"], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", webLog.fd, webLog.fd]
    });
    webIdentity = await waitForProcessIdentity(web.pid, WEB_MARKER, 2_000, launchId);
    const workerCommand = buildWorkerCommand();
    worker = await spawnDetached(
      workerCommand.command,
      workerCommand.args,
      {
        cwd: repoRoot,
        env: childEnv,
        stdio: ["ignore", workerLog.fd, workerLog.fd]
      }
    );
    workerIdentity = await waitForProcessIdentity(worker.pid, WORKER_MARKER, 2_000, launchId);
    metadata = {
      version: 1,
      launchId,
      web: webIdentity,
      worker: { ...workerIdentity, baselineBackendPids }
    };
    await writeProcessMetadata(metadataPath, metadata);
    metadataWritten = true;
    return await statusLocalProduction({ repoRoot, waitMs });
  } catch (error) {
    if (metadataWritten) {
      return await cleanupFailedStart({ metadata, metadataPath, originalError: error });
    }
    const recoveryRecords = [
      worker && (workerIdentity ?? {
        pid: worker.pid,
        pgid: worker.pid,
        marker: WORKER_MARKER,
        launchId
      }),
      web && (webIdentity ?? {
        pid: web.pid,
        pgid: web.pid,
        marker: WEB_MARKER,
        launchId
      })
    ].filter(Boolean);
    if (recoveryRecords.length === 0) throw error;
    return await cleanupSpawnFailure({
      records: recoveryRecords,
      metadataPath,
      originalError: error
    });
  } finally {
    await Promise.all([
      webLog?.close(),
      workerLog?.close(),
      startLock.release()
    ]);
  }
}

async function main() {
  const command = process.argv[2];
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  let result;
  if (command === "start") result = await startLocalProduction({ repoRoot });
  else if (command === "status") result = await statusLocalProduction({ repoRoot });
  else if (command === "stop") result = await stopLocalProduction({ repoRoot });
  else throw new Error("usage: node scripts/local-production-runtime.mjs <start|status|stop>");
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
