#!/usr/bin/env bash

CLEANUP_STARTED=false

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

remove_verification_container() {
  timeout --signal=KILL 10s docker rm -f "$POSTGRES_CONTAINER" >/dev/null 2>&1 || true
}

cleanup() {
  # Avoid an EXIT re-entry and ignore repeated terminal signals while bounded
  # cleanup is already in progress.
  trap - EXIT
  trap '' INT TERM
  [[ "$CLEANUP_STARTED" == "false" ]] || return 0
  CLEANUP_STARTED=true

  stop_process_group "$WORKER_PID" || true
  stop_process_group "$WEB_PID" || true
  remove_verification_container
  timeout --signal=KILL 10s /usr/bin/rm -rf -- \
    "$VERIFY_ASSET_ROOT" "$VERIFY_BIN_ROOT" "$VERIFY_RUNTIME_ROOT" >/dev/null 2>&1 || true
}

verification_signal_handler() {
  local signal="$1"
  local exit_code
  case "$signal" in
    INT) exit_code=130 ;;
    TERM) exit_code=143 ;;
    *) exit_code=1 ;;
  esac

  cleanup
  exit "$exit_code"
}

install_verification_traps() {
  trap cleanup EXIT
  trap 'verification_signal_handler INT' INT
  trap 'verification_signal_handler TERM' TERM
}
