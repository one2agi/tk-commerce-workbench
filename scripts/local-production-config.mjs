import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

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
  await initializeLocalProduction({
    credentialFile: process.argv[2] ?? resolve(repoRoot, "../TKskill/env.txt")
  });
  process.stdout.write(
    `Local production configuration initialized in mock mode at ${resolveStorageDir()}.\n`
  );
}
