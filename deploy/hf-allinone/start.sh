#!/bin/sh
set -eu

export PORT="${PORT:-1666}"
export NODE_ENV="${NODE_ENV:-production}"
export RUNTIME_CONFIG_PATH="${RUNTIME_CONFIG_PATH:-/app/config/runtime.json}"
export SEARCH_ENDPOINT="${SEARCH_ENDPOINT:-http://127.0.0.1:8080/search}"
export SEARCH_SH_CHAT_ENDPOINT="${SEARCH_SH_CHAT_ENDPOINT:-http://127.0.0.1:8000/v1/chat/completions}"
export ENABLE_GATEWAY_PROXY="${ENABLE_GATEWAY_PROXY:-true}"
export LIBRESEARCH_BASE_URL="${LIBRESEARCH_BASE_URL:-http://127.0.0.1:8080}"
export SEARCH2API_BASE_URL="${SEARCH2API_BASE_URL:-http://127.0.0.1:8000}"
export SEARXNG_PORT="${SEARXNG_PORT:-8080}"
export GRANIAN_HOST="${GRANIAN_HOST:-127.0.0.1}"
export GRANIAN_WORKERS="${GRANIAN_WORKERS:-1}"
export GRANIAN_BLOCKING_THREADS="${GRANIAN_BLOCKING_THREADS:-4}"
if [ -z "${GRANIAN_PROCESS_NAME:-}" ] || [ "${GRANIAN_PROCESS_NAME:-}" = "searxng" ]; then
  export GRANIAN_PROCESS_NAME="fusionsearch-libre"
fi

if [ -n "${API_MASTER_KEY:-}" ] && [ -z "${SEARCH_SH_API_KEY:-}" ]; then
  export SEARCH_SH_API_KEY="$API_MASTER_KEY"
fi

mkdir -p /app/config /app/logs

pids=""

start_service() {
  name="$1"
  logfile="$2"
  shift 2
  echo "[fusionsearch] starting $name"
  "$@" >>"/app/logs/$logfile.log" 2>>"/app/logs/$logfile.err.log" &
  pid="$!"
  pids="$pids $pid"
  echo "[fusionsearch] $name pid=$pid"
}

shutdown() {
  code="${1:-0}"
  trap - INT TERM
  for pid in $pids; do
    if kill -0 "$pid" 2>/dev/null; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in $pids; do
    wait "$pid" 2>/dev/null || true
  done
  exit "$code"
}

trap 'shutdown 143' INT TERM

start_service "libresearch" "libresearch" sh -c 'cd /usr/local/searxng && /usr/local/searxng/entrypoint.sh'
start_service "search2api" "search2api" /opt/search2api-venv/bin/uvicorn main:app --app-dir /app/services/search2api --host 127.0.0.1 --port 8000
start_service "fusionsearch" "fusionsearch" node /app/src/server.js

while :; do
  for pid in $pids; do
    if ! kill -0 "$pid" 2>/dev/null; then
      status=0
      wait "$pid" || status="$?"
      echo "[fusionsearch] child pid=$pid exited with status=$status"
      shutdown "$status"
    fi
  done
  sleep 2
done
