import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCAL_PRODUCTION_LIVE_ACK = "full-live-local-mvp";
const LIVE_ENV_KEYS = [
  "DATABASE_URL",
  "TEST_DATABASE_URL",
  "LOCAL_OPERATOR_ID",
  "EXTENSION_TOKEN",
  "NO_PROXY",
  "no_proxy",
  "MIAOSHOU_APP_KEY",
  "MIAOSHOU_APP_SECRET",
  "CANVAS_BASE_URL",
  "CANVAS_API_KEY",
  "CANVAS_ID",
  "CANVAS_WORKFLOW_NAME",
  "LLM_BASE_URL",
  "LLM_API_KEY",
  "LLM_MODEL",
  "IMAGE_PLANNER_BASE_URL",
  "IMAGE_PLANNER_API_KEY",
  "IMAGE_PLANNER_MODEL",
  "IMAGE_PROVIDER_BASE_URL",
  "IMAGE_PROVIDER_API_KEY",
  "IMAGE_PROVIDER_MODEL",
  "IMAGE_GENERATION_PATH",
  "EXCHANGE_RATE_BASE_URL",
  "ASSET_ROOT",
  "WORKER_CONCURRENCY",
  "WORKER_LEASE_MS",
  "MAX_CANVAS_RUNS_PER_DAY"
];

function validateCredentialValue(value, label) {
  if (!value) {
    throw new Error("Miaoshou APP ID and APP Secret are required");
  }
  if (/[\r\n\0=]/.test(value)) {
    throw new Error(`Miaoshou ${label} is invalid`);
  }
  return value;
}

export function parseMiaoshouCredentials(text) {
  const appKey = text.match(/^APP ID:[ \t]*([^\r\n]*)$/im)?.[1]?.trim();
  const appSecret = text
    .match(/^APP Secret:[ \t]*([^\r\n]*)$/im)?.[1]
    ?.trim();

  return {
    appKey: validateCredentialValue(appKey, "APP ID"),
    appSecret: validateCredentialValue(appSecret, "APP Secret")
  };
}

export function resolveStorageDir() {
  const override = process.env.TK_WORKBENCH_STORAGE_DIR;
  if (override && override.trim()) return resolve(override);
  return resolve(homedir(), ".local", "share", "tk-commerce-workbench");
}

function readEnvAssignments(text) {
  const result = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.includes("\0")) throw new Error("env contains NUL");
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error("invalid env assignment");
    const key = line.slice(0, separator).trim();
    if (key !== "no_proxy" && !/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`invalid env key: ${key}`);
    result[key] = line.slice(separator + 1);
  }
  return result;
}

function statusOf(value) {
  if (value === undefined) return "missing";
  return value === "" ? "empty" : "set";
}

export async function syncLiveProductionEnv({
  sourceEnvFile,
  storageDir = resolveStorageDir()
}) {
  const source = readEnvAssignments(await readFile(sourceEnvFile, "utf8"));
  const outputFile = join(storageDir, ".env");
  const lines = [];
  const status = {};

  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  await mkdir(join(storageDir, "data", "assets"), { recursive: true, mode: 0o700 });
  await mkdir(join(storageDir, "data", "runtime"), { recursive: true, mode: 0o700 });

  for (const key of LIVE_ENV_KEYS) {
    const value = source[key] ?? "";
    lines.push(`${key}=${value}`);
    status[key] = statusOf(source[key]);
  }
  lines.push("ALLOW_LAN=false");
  lines.push("EXTERNAL_ADAPTER_MODE=live");
  lines.push(`LOCAL_PRODUCTION_LIVE_ACK=${LOCAL_PRODUCTION_LIVE_ACK}`);
  status.ALLOW_LAN = "set";
  status.EXTERNAL_ADAPTER_MODE = "set";
  status.LOCAL_PRODUCTION_LIVE_ACK = "set";

  await writeFile(outputFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  return { synced: true, outputFile, status };
}

export async function initializeLocalProduction({
  credentialFile,
  storageDir = resolveStorageDir()
}) {
  const outputFile = join(storageDir, ".env");
  const assetRoot = join(storageDir, "data", "assets");
  const runtimeRoot = join(storageDir, "data", "runtime");
  await mkdir(storageDir, { recursive: true, mode: 0o700 });
  await mkdir(assetRoot, { recursive: true, mode: 0o700 });
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });

  const credentials = parseMiaoshouCredentials(
    await readFile(credentialFile, "utf8")
  );

  const lines = [
    "DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench",
    "TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:5432/tk_workbench_test",
    "LOCAL_OPERATOR_ID=local-operator",
    `EXTENSION_TOKEN=${randomBytes(32).toString("base64url")}`,
    "ALLOW_LAN=false",
    "EXTERNAL_ADAPTER_MODE=mock",
    `MIAOSHOU_APP_KEY=${credentials.appKey}`,
    `MIAOSHOU_APP_SECRET=${credentials.appSecret}`,
    "CANVAS_BASE_URL=https://canvas-n8n.ai2hook.com",
    "CANVAS_API_KEY=",
    "LLM_BASE_URL=",
    "LLM_API_KEY=",
    "LLM_MODEL=",
    "EXCHANGE_RATE_BASE_URL=",
    `ASSET_ROOT=${assetRoot}`,
    "WORKER_CONCURRENCY=2",
    "WORKER_LEASE_MS=60000",
    "MAX_CANVAS_RUNS_PER_DAY=50"
  ];

  await writeFile(outputFile, `${lines.join("\n")}\n`, {
    flag: "wx",
    mode: 0o600
  });
  return { created: true, assetRoot, runtimeRoot, storageDir, outputFile };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv[2] === "sync-live") {
    const result = await syncLiveProductionEnv({
      sourceEnvFile: resolve(process.argv[3] ?? join(repoRoot, ".env"))
    });
    process.stdout.write(`${JSON.stringify({ synced: result.synced, outputFile: result.outputFile, status: result.status })}\n`);
  } else {
    await initializeLocalProduction({
      credentialFile: process.argv[2] ?? resolve(repoRoot, "../TKskill/env.txt")
    });
    process.stdout.write(
      `Local production configuration initialized in mock mode at ${resolveStorageDir()}.\n`
    );
  }
}
