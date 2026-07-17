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
  { runtimeToken, hostEnv = process.env }
) {
  const inherited = {};
  for (const key of INHERITED_ENV_ALLOWLIST) {
    if (hostEnv[key] !== undefined) inherited[key] = hostEnv[key];
  }
  return {
    ...inherited,
    ...env,
    NODE_ENV: "production",
    TK_RUNTIME_HEALTH_TOKEN: runtimeToken
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
      const actual = await captureProcessIdentity(expected.pid, expected.marker);
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
  const pgid = Number(fields[2]);
  const startTimeTicks = fields[19];
  if (!Number.isSafeInteger(pgid) || pgid < 2 || !/^\d+$/.test(startTimeTicks ?? "")) {
    throw new Error(`invalid /proc/${pid}/stat identity`);
  }
  return { pgid, startTimeTicks };
}

export async function captureProcessIdentity(pid, marker) {
  if (!Number.isSafeInteger(pid) || pid < 2 || typeof marker !== "string" || !marker) {
    throw new Error("invalid process identity request");
  }
  const commandLine = (await readFile(`/proc/${pid}/cmdline`, "utf8"))
    .split("\0")
    .join(" ");
  if (!commandLine.includes(marker)) throw new Error(`PID ${pid} does not contain marker`);
  return { pid, ...(await readLinuxProcessState(pid)), marker };
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
  waitMs = 10_000
}) {
  const identity = { pid, pgid, startTimeTicks, marker };
  let leaderExists = true;
  try {
    const actual = await captureProcessIdentity(pid, marker);
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

  if (!(await groupExists(pgid))) return;
  process.kill(-identity.pgid, "SIGTERM");
  if (await waitForGroupExit(pgid, waitMs)) return;
  process.kill(-identity.pgid, "SIGKILL");
  if (await waitForGroupExit(pgid, waitMs)) return;
  throw new Error(`process group ${pgid} survived SIGKILL`);
}

async function waitForGroupExit(pgid, waitMs) {
  const deadline = Date.now() + Math.max(0, waitMs);
  do {
    if (!(await groupExists(pgid))) return true;
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(1, waitMs))));
  } while (Date.now() < deadline);
  return !(await groupExists(pgid));
}

function metadataPathFor(repoRoot) {
  return join(repoRoot, "data/runtime/processes.json");
}

function validateProcessRecord(value, label) {
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 2 ||
    !Number.isSafeInteger(value.pgid) ||
    value.pgid < 2 ||
    typeof value.startTimeTicks !== "string" ||
    !/^\d+$/.test(value.startTimeTicks) ||
    typeof value.marker !== "string" ||
    value.marker.length === 0
  ) {
    throw new Error(`invalid ${label} process metadata`);
  }
  return {
    pid: value.pid,
    pgid: value.pgid,
    startTimeTicks: value.startTimeTicks,
    marker: value.marker
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
  if (typeof metadata.healthToken !== "string" || !metadata.healthToken) {
    throw new Error("invalid runtime health token metadata");
  }
  if (typeof metadata.worker?.applicationName !== "string" || !metadata.worker.applicationName) {
    throw new Error("invalid worker application name metadata");
  }
  return {
    version: 1,
    healthToken: metadata.healthToken,
    web: validateProcessRecord(metadata.web, "web"),
    worker: {
      ...validateProcessRecord(metadata.worker, "worker"),
      applicationName: metadata.worker.applicationName
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

async function waitForProcessIdentity(pid, marker, waitMs = 2_000) {
  const deadline = Date.now() + waitMs;
  let lastError;
  do {
    try {
      return await captureProcessIdentity(pid, marker);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  } while (Date.now() < deadline);
  throw new Error(`PID ${pid} did not expose its runtime marker: ${lastError?.message}`);
}

function secretNeedles(env) {
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

async function webIsReady(healthToken) {
  try {
    const rootResponse = await fetch(WEB_URL, { signal: AbortSignal.timeout(1_000) });
    await rootResponse.body?.cancel();
    if (rootResponse.status < 200 || rootResponse.status >= 300) return false;
    const healthResponse = await fetch(`${WEB_URL}api/runtime-health`, {
      headers: { "x-tk-runtime-health-token": healthToken },
      signal: AbortSignal.timeout(1_000)
    });
    if (!healthResponse.ok) return false;
    return (await healthResponse.json()).token === healthToken;
  } catch {
    return false;
  }
}

async function workerIsReady(repoRoot, connectionString, applicationName) {
  let client;
  try {
    const requireFromDb = createRequire(join(repoRoot, "packages/db/package.json"));
    const { Client } = requireFromDb("pg");
    client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    await client.connect();
    const result = await client.query(
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = $1",
      [applicationName]
    );
    return Number(result.rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  } finally {
    await client?.end().catch(() => {});
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
  const env = await readRequiredEnv(repoRoot);
  assertSafeRuntimeEnv(env);
  const childEnv = buildChildEnvironment(env, { runtimeToken: metadata.healthToken });
  await inspectLogsOrStop(metadata, repoRoot, childEnv);
  await assertBothProcessesManaged(metadata);

  const deadline = Date.now() + waitMs;
  while (true) {
    await inspectLogsOrStop(metadata, repoRoot, childEnv);
    await assertBothProcessesManaged(metadata);
    const [webReady, workerReady] = await Promise.all([
      webIsReady(metadata.healthToken),
      workerIsReady(repoRoot, env.DATABASE_URL, metadata.worker.applicationName)
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
  await stopBoth(metadata, waitMs);
  await unlink(metadataPathFor(repoRoot));
  return { running: false };
}

export async function startLocalProduction({ repoRoot, waitMs = 60_000 }) {
  const env = await readRequiredEnv(repoRoot);
  assertSafeRuntimeEnv(env);
  await assertProductionBuild(repoRoot);

  const runtimeRoot = join(repoRoot, "data/runtime");
  const metadataPath = metadataPathFor(repoRoot);
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  try {
    const existing = await readProcessMetadata(repoRoot);
    await assertBothProcessesManaged(existing);
    throw new Error("local production is already running");
  } catch (error) {
    if (!/process metadata is required/.test(error.message)) throw error;
  }

  const webLog = await open(join(runtimeRoot, "web.log"), "a", 0o600);
  const workerLog = await open(join(runtimeRoot, "worker.log"), "a", 0o600);
  const healthToken = randomBytes(24).toString("base64url");
  const applicationName = `tk-workbench-local-worker-${healthToken.slice(0, 16)}`;
  const childEnv = buildChildEnvironment(env, { runtimeToken: healthToken });
  let web;
  let worker;
  let webIdentity;
  let workerIdentity;
  let metadata;
  let metadataWritten = false;
  try {
    web = await spawnDetached("pnpm", ["--filter", "@tk/web", "start"], {
      cwd: repoRoot,
      env: childEnv,
      stdio: ["ignore", webLog.fd, webLog.fd]
    });
    webIdentity = await waitForProcessIdentity(web.pid, WEB_MARKER);
    worker = await spawnDetached(
      "env",
      [`PGAPPNAME=${applicationName}`, "pnpm", "--filter", "@tk/worker", "start"],
      {
        cwd: repoRoot,
        env: childEnv,
        stdio: ["ignore", workerLog.fd, workerLog.fd]
      }
    );
    workerIdentity = await waitForProcessIdentity(worker.pid, WORKER_MARKER);
    metadata = {
      version: 1,
      healthToken,
      web: webIdentity,
      worker: { ...workerIdentity, applicationName }
    };
    await writeProcessMetadata(metadataPath, metadata);
    metadataWritten = true;
    return await statusLocalProduction({ repoRoot, waitMs });
  } catch (error) {
    if (metadataWritten) {
      return await cleanupFailedStart({ metadata, metadataPath, originalError: error });
    }
    const cleanupErrors = [];
    if (metadata) {
      try {
        await stopBoth(metadata, 10_000);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
    } else {
      for (const [child, identity, marker] of [
        [worker, workerIdentity, WORKER_MARKER],
        [web, webIdentity, WEB_MARKER]
      ]) {
        if (!child) continue;
        try {
          await stopManagedProcess(identity ?? await captureProcessIdentity(child.pid, marker));
        } catch (cleanupError) {
          if (await groupExists(child.pid)) cleanupErrors.push(cleanupError);
        }
      }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [error, ...cleanupErrors],
        [error, ...cleanupErrors].map((caught) => caught.message).join("; ")
      );
    }
    throw error;
  } finally {
    await Promise.all([webLog.close(), workerLog.close()]);
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
