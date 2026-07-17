import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import {
  mkdir,
  open,
  readFile,
  stat,
  unlink,
  writeFile
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_URL = "http://127.0.0.1:3000/";
const WORKER_APPLICATION_NAME = "tk-workbench-local-worker";
const WEB_MARKER = "pnpm --filter @tk/web start";
const WORKER_MARKER = "pnpm --filter @tk/worker start";

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
  if (!Number.isSafeInteger(pid) || pid < 2) return false;
  try {
    const commandLine = await readFile(`/proc/${pid}/cmdline`, "utf8");
    return commandLine.split("\0").join(" ").includes(marker);
  } catch {
    return false;
  }
}

export async function stopManagedProcess({ pid, marker, waitMs = 10_000 }) {
  if (!(await processIsManaged(pid, marker))) throw new Error(`refusing unmanaged PID ${pid}`);
  process.kill(-pid, "SIGTERM");
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    if (!(await processIsManaged(pid, marker))) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  process.kill(-pid, "SIGKILL");
  if (await processIsManaged(pid, marker)) throw new Error(`process group ${pid} survived SIGKILL`);
}

function metadataPathFor(repoRoot) {
  return join(repoRoot, "data/runtime/processes.json");
}

function validateProcessRecord(value, label) {
  if (
    !value ||
    !Number.isSafeInteger(value.pid) ||
    value.pid < 2 ||
    typeof value.marker !== "string" ||
    value.marker.length === 0
  ) {
    throw new Error(`invalid ${label} process metadata`);
  }
  return { pid: value.pid, marker: value.marker };
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
  return {
    version: 1,
    web: validateProcessRecord(metadata.web, "web"),
    worker: validateProcessRecord(metadata.worker, "worker")
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

function secretNeedles(env) {
  const values = Object.entries(env)
    .filter(([key, value]) => /(?:SECRET|TOKEN|PASSWORD|API_KEY)$/.test(key) && value)
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

async function webIsReady() {
  try {
    const response = await fetch(WEB_URL, { signal: AbortSignal.timeout(1_000) });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 300;
  } catch {
    return false;
  }
}

async function workerIsReady(repoRoot, connectionString) {
  let client;
  try {
    const requireFromDb = createRequire(join(repoRoot, "packages/db/package.json"));
    const { Client } = requireFromDb("pg");
    client = new Client({ connectionString, connectionTimeoutMillis: 1_000 });
    await client.connect();
    const result = await client.query(
      "SELECT count(*)::integer AS count FROM pg_stat_activity WHERE application_name = $1",
      [WORKER_APPLICATION_NAME]
    );
    return Number(result.rows[0]?.count ?? 0) > 0;
  } catch {
    return false;
  } finally {
    await client?.end().catch(() => {});
  }
}

async function assertBothProcessesManaged(metadata) {
  if (!(await processIsManaged(metadata.web.pid, metadata.web.marker))) {
    throw new Error(`web PID ${metadata.web.pid} is stale or not managed`);
  }
  if (!(await processIsManaged(metadata.worker.pid, metadata.worker.marker))) {
    throw new Error(`worker PID ${metadata.worker.pid} is stale or not managed`);
  }
}

export async function statusLocalProduction({ repoRoot, waitMs = 60_000 }) {
  const metadata = await readProcessMetadata(repoRoot);
  await assertBothProcessesManaged(metadata);
  const env = await readRequiredEnv(repoRoot);
  assertSafeRuntimeEnv(env);

  const deadline = Date.now() + waitMs;
  while (true) {
    await assertBothProcessesManaged(metadata);
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
    const [webReady, workerReady] = await Promise.all([
      webIsReady(),
      workerIsReady(repoRoot, env.DATABASE_URL)
    ]);
    if (webReady && workerReady) {
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
  let web;
  let worker;
  let metadataWritten = false;
  try {
    web = await spawnDetached("pnpm", ["--filter", "@tk/web", "start"], {
      cwd: repoRoot,
      env: { ...process.env, ...env },
      stdio: ["ignore", webLog.fd, webLog.fd]
    });
    worker = await spawnDetached(
      "env",
      ["PGAPPNAME=tk-workbench-local-worker", "pnpm", "--filter", "@tk/worker", "start"],
      {
        cwd: repoRoot,
        env: { ...process.env, ...env },
        stdio: ["ignore", workerLog.fd, workerLog.fd]
      }
    );
    const metadata = {
      version: 1,
      web: { pid: web.pid, marker: WEB_MARKER },
      worker: { pid: worker.pid, marker: WORKER_MARKER }
    };
    await writeProcessMetadata(metadataPath, metadata);
    metadataWritten = true;
    return await statusLocalProduction({ repoRoot, waitMs });
  } catch (error) {
    const records = [
      worker && { pid: worker.pid, marker: WORKER_MARKER },
      web && { pid: web.pid, marker: WEB_MARKER }
    ].filter(Boolean);
    for (const record of records) {
      if (await processIsManaged(record.pid, record.marker)) {
        await stopManagedProcess({ ...record }).catch(() => {});
      }
    }
    if (metadataWritten) await unlink(metadataPath).catch(() => {});
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
