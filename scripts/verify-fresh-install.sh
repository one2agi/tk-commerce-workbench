#!/usr/bin/env bash
set -Eeuo pipefail

readonly POSTGRES_CONTAINER="tk-workbench-verify-$$"
readonly VERIFY_ASSET_ROOT="${TMPDIR:-/tmp}/tk-workbench-assets-$$"
readonly VERIFY_BIN_ROOT="${TMPDIR:-/tmp}/tk-workbench-corepack-$$"
readonly VERIFY_RUNTIME_ROOT="${TMPDIR:-/tmp}/tk-workbench-runtime-$$"
WEB_PID=""
WORKER_PID=""

stop_process_group() {
  local pid="${1:-}"
  [[ -n "$pid" ]] || return 0
  kill -TERM -- "-$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    kill -0 -- "-$pid" >/dev/null 2>&1 || { wait "$pid" 2>/dev/null || true; return 0; }
    sleep 0.25
  done
  kill -KILL -- "-$pid" >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do
    kill -0 -- "-$pid" >/dev/null 2>&1 || break
    sleep 0.25
  done
  wait "$pid" 2>/dev/null || true
  ! kill -0 -- "-$pid" >/dev/null 2>&1
}

cleanup() {
  stop_process_group "$WORKER_PID" || true
  stop_process_group "$WEB_PID" || true
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  /usr/bin/rm -rf -- "$VERIFY_ASSET_ROOT" "$VERIFY_BIN_ROOT" "$VERIFY_RUNTIME_ROOT"
}
trap cleanup EXIT INT TERM

command -v node >/dev/null
command -v docker >/dev/null
[[ "$(node --version)" == v22.* ]] || { echo "Node.js 22 is required" >&2; exit 1; }

mkdir -p "$VERIFY_BIN_ROOT" "$VERIFY_RUNTIME_ROOT"
corepack enable --install-directory "$VERIFY_BIN_ROOT"
export PATH="$VERIFY_BIN_ROOT:$PATH"
corepack prepare pnpm@9.15.9 --activate
[[ "$(pnpm --version)" == "9.15.9" ]]
pnpm install --frozen-lockfile
if [[ "$(id -u)" == "0" ]] || sudo -n true >/dev/null 2>&1; then
  pnpm exec playwright install --with-deps chromium
else
  pnpm exec playwright install chromium
fi

docker run -d --rm \
  --name "$POSTGRES_CONTAINER" \
  -e POSTGRES_USER=postgres \
  -e POSTGRES_PASSWORD=postgres \
  -e POSTGRES_DB=tk_workbench \
  -p 127.0.0.1::5432 \
  --health-cmd='pg_isready -U postgres -d tk_workbench' \
  --health-interval=2s \
  --health-timeout=3s \
  --health-retries=30 \
  postgres:16-alpine >/dev/null

for _ in $(seq 1 60); do
  [[ "$(docker inspect -f '{{.State.Health.Status}}' "$POSTGRES_CONTAINER")" == healthy ]] && break
  sleep 1
done
[[ "$(docker inspect -f '{{.State.Health.Status}}' "$POSTGRES_CONTAINER")" == healthy ]]

readonly PG_PORT="$(docker port "$POSTGRES_CONTAINER" 5432/tcp | sed -E 's/.*:([0-9]+)$/\1/')"
test_database_created=false
for _ in $(seq 1 30); do
  if docker exec "$POSTGRES_CONTAINER" createdb -U postgres tk_workbench_test >/dev/null 2>&1; then
    test_database_created=true
    break
  fi
  sleep 1
done
[[ "$test_database_created" == "true" ]]

export DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${PG_PORT}/tk_workbench"
export TEST_DATABASE_URL="postgres://postgres:postgres@127.0.0.1:${PG_PORT}/tk_workbench_test"
export LOCAL_OPERATOR_ID="local-operator"
export EXTENSION_TOKEN="local-verification-token-not-for-production"
export ALLOW_LAN="false"
export EXTERNAL_ADAPTER_MODE="mock"
export ASSET_ROOT="$VERIFY_ASSET_ROOT"

pnpm db:migrate
docker exec -i "$POSTGRES_CONTAINER" psql -v ON_ERROR_STOP=1 -U postgres -d tk_workbench <<'SQL'
INSERT INTO local_operators (id, handle, display_name)
VALUES ('op_local_operator', 'local-operator', 'Local Operator')
ON CONFLICT (handle) DO UPDATE SET display_name = EXCLUDED.display_name;
SQL

pnpm lint
pnpm typecheck
NODE_ENV=production pnpm build

# Prove the production Web bundle really becomes HTTP-ready. A successful
# `next build` alone does not detect an unusable startup command or runtime
# configuration.
readonly WEB_PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})')"
setsid env PORT="$WEB_PORT" NODE_ENV=production \
  pnpm --filter @tk/web start \
  >"$VERIFY_RUNTIME_ROOT/web.log" 2>&1 &
WEB_PID="$!"
web_ready=false
for _ in $(seq 1 60); do
  if node -e 'fetch(process.argv[1],{signal:AbortSignal.timeout(5000)}).then(async r=>{await r.body?.cancel();if(!r.ok)process.exitCode=1}).catch(()=>process.exitCode=1)' \
    "http://127.0.0.1:${WEB_PORT}/"; then
    web_ready=true
    break
  fi
  kill -0 "$WEB_PID" >/dev/null 2>&1 || break
  sleep 1
done
if [[ "$web_ready" != "true" ]]; then
  sed -n '1,160p' "$VERIFY_RUNTIME_ROOT/web.log" >&2
  echo "Web did not become HTTP-ready" >&2
  exit 1
fi
stop_process_group "$WEB_PID"
WEB_PID=""

# Start the real Worker CLI in mock-adapter mode. A tagged PostgreSQL session
# proves that module loading finished and polling actually began; merely seeing
# an OS process would also accept a slow process that dies during startup.
setsid env PGAPPNAME=tk-workbench-worker-smoke \
  node --import tsx apps/worker/src/cli.ts \
  >"$VERIFY_RUNTIME_ROOT/worker.log" 2>&1 &
WORKER_PID="$!"
worker_connected=false
for _ in $(seq 1 60); do
  if ! kill -0 "$WORKER_PID" >/dev/null 2>&1; then
    sed -n '1,160p' "$VERIFY_RUNTIME_ROOT/worker.log" >&2
    echo "Worker stopped before opening its polling connection" >&2
    exit 1
  fi
  connection_count="$(docker exec "$POSTGRES_CONTAINER" psql -U postgres -d tk_workbench -tAc \
    "SELECT count(*) FROM pg_stat_activity WHERE application_name = 'tk-workbench-worker-smoke'" | tr -d '[:space:]')"
  if [[ "${connection_count:-0}" -gt 0 ]]; then
    worker_connected=true
    break
  fi
  sleep 1
done
[[ "$worker_connected" == "true" ]] || {
  sed -n '1,160p' "$VERIFY_RUNTIME_ROOT/worker.log" >&2
  echo "Worker did not begin polling PostgreSQL" >&2
  exit 1
}
sleep 2
kill -0 "$WORKER_PID" >/dev/null 2>&1 || {
  sed -n '1,160p' "$VERIFY_RUNTIME_ROOT/worker.log" >&2
  echo "Worker did not remain running after polling began" >&2
  exit 1
}
kill -TERM "$WORKER_PID"
worker_shutdown_complete=false
worker_exit_code=0
for _ in $(seq 1 40); do
  if ! kill -0 "$WORKER_PID" >/dev/null 2>&1; then
    if wait "$WORKER_PID"; then worker_exit_code=0; else worker_exit_code="$?"; fi
    worker_shutdown_complete=true
    break
  fi
  sleep 0.25
done
if [[ "$worker_shutdown_complete" != "true" ]]; then
  stop_process_group "$WORKER_PID" || true
  WORKER_PID=""
  sed -n '1,160p' "$VERIFY_RUNTIME_ROOT/worker.log" >&2
  echo "Worker did not shut down within 10 seconds after SIGTERM" >&2
  exit 1
fi
if [[ "$worker_exit_code" -ne 0 ]]; then
  sed -n '1,160p' "$VERIFY_RUNTIME_ROOT/worker.log" >&2
  echo "Worker did not shut down cleanly after SIGTERM" >&2
  exit 1
fi
WORKER_PID=""

# Validate the built MV3 package structurally, then ask the same bundled
# Chromium used by E2E to load it and start its service worker.
readonly EXTENSION_DIST="$PWD/apps/extension/dist"
readonly EXTENSION_PROFILE="$VERIFY_RUNTIME_ROOT/chromium-profile"
export EXTENSION_DIST EXTENSION_PROFILE
node --input-type=module <<'NODE'
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = process.env.EXTENSION_DIST;
if (!root) throw new Error("EXTENSION_DIST is required");
const manifest = JSON.parse(readFileSync(resolve(root, "manifest.json"), "utf8"));
if (manifest.manifest_version !== 3) throw new Error("extension manifest must be MV3");
const entries = [
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((item) => item.js ?? []),
  manifest.options_ui?.page,
  manifest.action?.default_popup
];
if (entries.some((entry) => typeof entry !== "string" || !existsSync(resolve(root, entry)))) {
  throw new Error("extension manifest references a missing entry");
}
NODE
node --input-type=module <<'NODE'
import { chromium } from "@playwright/test";

const extensionPath = process.env.EXTENSION_DIST;
const profilePath = process.env.EXTENSION_PROFILE;
if (!extensionPath || !profilePath) throw new Error("extension smoke paths are required");
const context = await chromium.launchPersistentContext(profilePath, {
  channel: "chromium",
  headless: true,
  args: [
    `--disable-extensions-except=${extensionPath}`,
    `--load-extension=${extensionPath}`
  ]
});
try {
  let worker = context.serviceWorkers()[0];
  worker ??= await context.waitForEvent("serviceworker", { timeout: 15_000 });
  if (!worker.url().startsWith("chrome-extension://")) {
    throw new Error(`unexpected extension worker URL: ${worker.url()}`);
  }
} finally {
  await context.close();
}
NODE

pnpm test
pnpm test:integration
pnpm test:e2e
