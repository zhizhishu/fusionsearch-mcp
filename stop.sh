#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [ ! -f "server.pid" ]; then
  echo "[stop] 未找到 server.pid，可能服务未在后台运行。"
  exit 0
fi

PID=$(cat server.pid)
if kill -0 "$PID" >/dev/null 2>&1; then
  echo "[stop] 停止进程 $PID ..."
  kill "$PID"
  wait "$PID" 2>/dev/null || true
  echo "[stop] 进程已停止。"
else
  echo "[stop] 进程 $PID 不存在，清理 pid 文件。"
fi

rm -f server.pid
