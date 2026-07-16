#!/usr/bin/env bash
set -Eeuo pipefail

readonly POSTGRES_CONTAINER="tk-workbench-verify-$$"
readonly VERIFY_ASSET_ROOT="${TMPDIR:-/tmp}/tk-workbench-assets-$$"
readonly VERIFY_BIN_ROOT="${TMPDIR:-/tmp}/tk-workbench-corepack-$$"

cleanup() {
  docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
  /usr/bin/rm -rf -- "$VERIFY_ASSET_ROOT" "$VERIFY_BIN_ROOT"
}
trap cleanup EXIT INT TERM

command -v node >/dev/null
command -v docker >/dev/null
[[ "$(node --version)" == v22.* ]] || { echo "Node.js 22 is required" >&2; exit 1; }

mkdir -p "$VERIFY_BIN_ROOT"
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
pnpm test
pnpm test:integration
pnpm test:e2e
