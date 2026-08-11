#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { connect as netConnect } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_STORAGE_DIR = resolve(homedir(), ".local", "share", "tk-commerce-workbench");
const RUNTIME_DIR = join(
  process.env.TK_WORKBENCH_STORAGE_DIR ?? DEFAULT_STORAGE_DIR,
  "data",
  "runtime"
);
const WEB_URL = "http://127.0.0.1:3000";
const POSTGRES_SERVICE = "postgres";
const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "NODE_TLS_REJECT_UNAUTHORIZED"
];
const LOOPBACK_NO_PROXY = ["127.0.0.1", "localhost", "::1"];
const EXTERNAL_PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy"
];

export function readEnvFile(text) {
  const env = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator <= 0) throw new Error(`invalid env assignment: ${rawLine}`);
    env[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return env;
}

export function sanitizeProxyEnvironment(hostEnv = process.env) {
  const next = { ...hostEnv };
  for (const key of PROXY_ENV_KEYS) delete next[key];
  next.NO_PROXY = mergeNoProxy(hostEnv.NO_PROXY ?? hostEnv.no_proxy ?? "");
  next.no_proxy = next.NO_PROXY;
  if (process.platform === "linux") {
    next.TMPDIR = "/tmp";
    next.TMP = "/tmp";
    next.TEMP = "/tmp";
  }
  return next;
}

export function mergeNoProxy(existing) {
  const values = new Set(
    String(existing)
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean)
  );
  for (const value of LOOPBACK_NO_PROXY) values.add(value);
  return Array.from(values).join(",");
}

export function buildRuntimeEnvironment({
  envFile,
  hostEnv = process.env,
  launchId
}) {
  const sanitized = sanitizeProxyEnvironment(hostEnv);
  const liveWorkerContext = envFile.EXTERNAL_ADAPTER_MODE === "live"
    ? {
        WORKER_COMMAND_ID: `local-production-${launchId}`,
        WORKER_IDEMPOTENCY_KEY: `local-production-${launchId}-worker`
      }
    : {};
  return {
    ...sanitized,
    ...envFile,
    ...liveWorkerContext,
    NODE_ENV: "production",
    TK_RUNTIME_LAUNCH_ID: launchId,
    NO_PROXY: mergeNoProxy(envFile.NO_PROXY ?? sanitized.NO_PROXY),
    no_proxy: mergeNoProxy(envFile.no_proxy ?? sanitized.no_proxy)
  };
}

export function buildWorkerEnvironment({
  runtimeEnv,
  hostEnv = process.env,
  workerReadyPath
}) {
  const proxyEnv = {};
  for (const key of EXTERNAL_PROXY_ENV_KEYS) {
    if (hostEnv[key]) proxyEnv[key] = hostEnv[key];
  }
  return {
    ...runtimeEnv,
    ...proxyEnv,
    PGAPPNAME: "tk-workbench-local-worker",
    TK_WORKER_READY_PATH: workerReadyPath,
    NO_PROXY: mergeNoProxy(hostEnv.NO_PROXY ?? hostEnv.no_proxy ?? runtimeEnv.NO_PROXY),
    no_proxy: mergeNoProxy(hostEnv.no_proxy ?? hostEnv.NO_PROXY ?? runtimeEnv.no_proxy)
  };
}

export function resolveEnvFilePath({
  repoRoot = REPO_ROOT,
  storageDir = process.env.TK_WORKBENCH_STORAGE_DIR ?? DEFAULT_STORAGE_DIR
} = {}) {
  const storageEnv = join(storageDir, ".env");
  if (existsSync(storageEnv)) return storageEnv;
  return join(repoRoot, ".env");
}

export async function portOpen(host, port, timeoutMs = 1_000) {
  return new Promise((resolveResult) => {
    const socket = netConnect({ host, port });
    const done = (result) => {
      socket.removeAllListeners();
      socket.destroy();
      resolveResult(result);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

async function loadRuntimeEnv() {
  const envFilePath = resolveEnvFilePath();
  if (!existsSync(envFilePath)) {
    throw new Error(`missing env file: ${envFilePath}`);
  }
  const envFile = readEnvFile(await readFile(envFilePath, "utf8"));
  for (const key of ["DATABASE_URL", "TEST_DATABASE_URL", "LOCAL_OPERATOR_ID", "CONFIG_ENCRYPTION_KEY"]) {
    if (!envFile[key]) throw new Error(`required env ${key} is missing in ${envFilePath}`);
  }
  return { envFilePath, envFile };
}

function parsePostgresEndpoint(databaseUrl) {
  const url = new URL(databaseUrl);
  return {
    host: url.hostname,
    port: Number(url.port || "5432")
  };
}

async function commandSucceeds(command, args, options = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? sanitizeProxyEnvironment(),
      shell: false,
      stdio: "ignore"
    });
    child.once("error", () => resolveResult(false));
    child.once("exit", (code) => resolveResult(code === 0));
  });
}

async function runChecked(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? sanitizeProxyEnvironment(),
      shell: options.shell ?? false,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) reject(new Error(`${command} stopped by ${signal}`));
      else if (code === 0) resolveResult();
      else reject(new Error(`${command} exited with ${code}`));
    });
  });
}

async function waitUntil(check, { timeoutMs, intervalMs, label }) {
  const startedAt = Date.now();
  while (Date.now() - startedAt <= timeoutMs) {
    if (await check()) return;
    await new Promise((resolveResult) => setTimeout(resolveResult, intervalMs));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function startDockerDesktopIfPossible() {
  if (process.platform !== "linux" || !existsSync("/mnt/c/Windows/System32/cmd.exe")) return;
  console.log("[db] Docker daemon is not ready. Trying to open Docker Desktop...");
  await commandSucceeds("cmd.exe", [
    "/c",
    "start",
    "",
    "C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe"
  ]);
}

async function dockerInfoReady() {
  if (await commandSucceeds("docker", ["info"])) return true;
  if (process.platform === "linux" && existsSync("/mnt/c/Windows/System32/cmd.exe")) {
    return commandSucceeds("cmd.exe", [
      "/c",
      "C:\\Progra~1\\Docker\\Docker\\resources\\bin\\docker.exe",
      "info"
    ]);
  }
  return false;
}

async function dockerComposeUp(repoRoot = REPO_ROOT) {
  if (await commandSucceeds("docker", ["compose", "version"])) {
    await runChecked("docker", ["compose", "up", "-d", "--wait", POSTGRES_SERVICE], { cwd: repoRoot });
    return;
  }
  if (process.platform === "linux" && existsSync("/mnt/c/Windows/System32/cmd.exe")) {
    const windowsRepo = await capture("wslpath", ["-w", repoRoot]).catch(() => "");
    if (windowsRepo.trim()) {
      await runChecked("cmd.exe", [
        "/c",
        `cd /d "${windowsRepo.trim()}" && C:\\Progra~1\\Docker\\Docker\\resources\\bin\\docker.exe compose up -d --wait ${POSTGRES_SERVICE}`
      ]);
      return;
    }
  }
  throw new Error("docker compose is unavailable");
}

function capture(command, args, options = {}) {
  return new Promise((resolveResult, reject) => {
    let stdout = "";
    let stderr = "";
    const child = spawn(command, args, {
      cwd: options.cwd ?? REPO_ROOT,
      env: options.env ?? sanitizeProxyEnvironment(),
      shell: false
    });
    child.stdout?.on("data", (chunk) => { stdout += chunk; });
    child.stderr?.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveResult(stdout);
      else reject(new Error(stderr || `${command} exited with ${code}`));
    });
  });
}

async function ensurePostgres(databaseUrl) {
  const endpoint = parsePostgresEndpoint(databaseUrl);
  if (await portOpen(endpoint.host, endpoint.port)) {
    console.log(`[db] PostgreSQL is reachable at ${endpoint.host}:${endpoint.port}`);
    return;
  }

  if (!(await dockerInfoReady())) {
    await startDockerDesktopIfPossible();
    await waitUntil(dockerInfoReady, {
      timeoutMs: 120_000,
      intervalMs: 3_000,
      label: "Docker Desktop"
    }).catch((error) => {
      throw new Error(`${error.message}. Please open Docker Desktop manually, then run this script again.`);
    });
  }

  console.log("[db] Starting PostgreSQL container...");
  await dockerComposeUp();
  await waitUntil(() => portOpen(endpoint.host, endpoint.port), {
    timeoutMs: 60_000,
    intervalMs: 1_000,
    label: `PostgreSQL ${endpoint.host}:${endpoint.port}`
  });
  console.log(`[db] PostgreSQL is reachable at ${endpoint.host}:${endpoint.port}`);
}

async function ensureBuild(runtimeEnv) {
  const buildId = join(REPO_ROOT, "apps", "web", ".next", "BUILD_ID");
  if (existsSync(buildId) && process.argv.includes("--skip-build")) {
    console.log("[build] Using existing web production build");
    return;
  }
  if (existsSync(buildId) && !process.argv.includes("--build")) {
    console.log("[build] Existing web production build found");
    return;
  }
  console.log("[build] Building web production bundle...");
  await runChecked("pnpm", ["--filter", "@tk/web", "build"], { env: runtimeEnv });
}

async function migrateDatabase(runtimeEnv) {
  console.log("[db] Running migrations...");
  await runChecked("pnpm", ["db:migrate"], { env: runtimeEnv });
}

function spawnService(name, command, args, runtimeEnv) {
  const child = spawn(command, args, {
    cwd: REPO_ROOT,
    env: runtimeEnv,
    stdio: ["ignore", "pipe", "pipe"],
    shell: process.platform === "win32"
  });
  child.stdout.on("data", (chunk) => process.stdout.write(prefixLines(name, chunk)));
  child.stderr.on("data", (chunk) => process.stderr.write(prefixLines(name, chunk)));
  child.once("exit", (code, signal) => {
    console.error(`[${name}] exited ${signal ?? code}`);
  });
  return child;
}

function prefixLines(name, chunk) {
  return String(chunk)
    .split(/(?<=\n)/)
    .map((line) => line ? `[${name}] ${line}` : line)
    .join("");
}

async function requestJson(url, timeoutMs = 1_500) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) return null;
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForWeb() {
  await waitUntil(async () => {
    const health = await requestJson(`${WEB_URL}/api/runtime-health`).catch(() => null);
    return Boolean(health?.launchId);
  }, {
    timeoutMs: 120_000,
    intervalMs: 2_000,
    label: "web runtime health"
  });
  console.log(`[web] Ready: ${WEB_URL}`);
}

async function waitForWorker(readyPath, launchId) {
  await waitUntil(async () => {
    const ready = await readFile(readyPath, "utf8").then(JSON.parse).catch(() => null);
    return ready?.launchId === launchId && Number.isInteger(ready?.pid);
  }, {
    timeoutMs: 60_000,
    intervalMs: 1_000,
    label: "worker readiness"
  });
  console.log("[worker] Ready");
}

function rejectOnEarlyExit(child, name) {
  return new Promise((_, reject) => {
    child.once("exit", (code, signal) => {
      reject(new Error(`${name} exited before startup completed: ${signal ?? code}`));
    });
  });
}

async function main() {
  const { envFilePath, envFile } = await loadRuntimeEnv();
  const launchId = `one-click-${Date.now().toString(36)}`;
  const runtimeEnv = buildRuntimeEnvironment({ envFile, launchId });
  const workerReadyPath = join(RUNTIME_DIR, `worker-ready-${launchId}.json`);

  console.log(`[env] Loaded ${envFilePath}`);
  console.log("[env] Cleared proxy variables for local Next/loopback startup");

  await ensurePostgres(envFile.DATABASE_URL);
  await migrateDatabase(runtimeEnv);
  await ensureBuild(runtimeEnv);
  await mkdir(RUNTIME_DIR, { recursive: true });

  console.log("[start] Starting web and worker. Keep this terminal open.");
  const workerEnv = buildWorkerEnvironment({ runtimeEnv, workerReadyPath });
  const web = spawnService("web", "pnpm", ["--filter", "@tk/web", "start"], runtimeEnv);
  const worker = spawnService("worker", "pnpm", ["--filter", "@tk/worker", "start"], workerEnv);

  const shutdown = () => {
    console.log("\n[stop] Stopping local production services...");
    web.kill("SIGTERM");
    worker.kill("SIGTERM");
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

  try {
    await Promise.all([
      Promise.race([waitForWeb(), rejectOnEarlyExit(web, "web")]),
      Promise.race([waitForWorker(workerReadyPath, launchId), rejectOnEarlyExit(worker, "worker")])
    ]);
  } catch (error) {
    web.kill("SIGTERM");
    worker.kill("SIGTERM");
    throw error;
  }
  console.log("[ok] Local production is running.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(`[error] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
