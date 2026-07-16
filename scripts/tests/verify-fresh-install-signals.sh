#!/usr/bin/env bash
set -Eeuo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
readonly RUNTIME_LIBRARY="$REPO_ROOT/scripts/lib/verify-fresh-install-runtime.sh"
readonly TEST_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/tk-workbench-signal-test.XXXXXX")"

cleanup_test_root() {
  /usr/bin/rm -rf -- "$TEST_ROOT"
}
trap cleanup_test_root EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

wait_for_file() {
  local path="$1"
  for _ in $(seq 1 100); do
    [[ -f "$path" ]] && return 0
    sleep 0.05
  done
  return 1
}

run_signal_case() {
  local signal="$1"
  local expected_exit="$2"
  local case_root="$TEST_ROOT/${signal,,}"
  mkdir -p "$case_root"

  env CASE_ROOT="$case_root" RUNTIME_LIBRARY="$RUNTIME_LIBRARY" \
    timeout --preserve-status 30s bash <<'HARNESS' &
set -Eeuo pipefail
source "$RUNTIME_LIBRARY"

readonly POSTGRES_CONTAINER="signal-test-postgres"
readonly VERIFY_ASSET_ROOT="$CASE_ROOT/assets"
readonly VERIFY_BIN_ROOT="$CASE_ROOT/bin"
readonly VERIFY_RUNTIME_ROOT="$CASE_ROOT/runtime"
WEB_PID=""
WORKER_PID=""

remove_verification_container() {
  printf '%s\n' "$*" >>"$CASE_ROOT/cleanup-calls"
}

mkdir -p "$VERIFY_ASSET_ROOT" "$VERIFY_BIN_ROOT" "$VERIFY_RUNTIME_ROOT"
setsid sleep 300 &
WORKER_PID="$!"
printf '%s\n' "$WORKER_PID" >"$CASE_ROOT/child-pid"
install_verification_traps
printf '%s\n' "$$" >"$CASE_ROOT/harness-pid"
touch "$CASE_ROOT/ready"
while :; do :; done
touch "$CASE_ROOT/continued-after-signal"
HARNESS
  local supervisor_pid="$!"

  wait_for_file "$case_root/ready" || fail "$signal harness did not become ready"
  local child_pid harness_pid
  child_pid="$(<"$case_root/child-pid")"
  harness_pid="$(<"$case_root/harness-pid")"
  kill -s "$signal" "$harness_pid"

  local status=0
  if wait "$supervisor_pid"; then
    status=0
  else
    status="$?"
  fi

  [[ "$status" -eq "$expected_exit" ]] || fail "$signal exited $status, expected $expected_exit"
  [[ ! -e "$case_root/continued-after-signal" ]] || fail "$signal continued into later steps"
  [[ ! -e "$case_root/assets" && ! -e "$case_root/bin" && ! -e "$case_root/runtime" ]] || \
    fail "$signal left temporary directories behind"
  [[ "$(wc -l <"$case_root/cleanup-calls")" -eq 1 ]] || fail "$signal cleanup ran more than once"
  ! kill -0 -- "-$child_pid" >/dev/null 2>&1 || fail "$signal left the child process group running"
}

run_signal_case INT 130
run_signal_case TERM 143

[[ "$(grep -c '^install_verification_traps$' "$REPO_ROOT/scripts/verify-fresh-install.sh")" -eq 1 ]] || \
  fail "fresh-install entrypoint does not install the verified traps"
! grep -q '^trap cleanup EXIT INT TERM$' "$REPO_ROOT/scripts/verify-fresh-install.sh" || \
  fail "fresh-install entrypoint still uses the ambiguous shared signal trap"

echo "PASS: fresh-install signal handling"
