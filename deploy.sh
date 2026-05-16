#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

LOG_DIR="$SCRIPT_DIR/logs"
mkdir -p "$LOG_DIR"

LOG_FILE="$LOG_DIR/server-$(date '+%Y%m%d-%H%M%S').log"
PID_FILE="$SCRIPT_DIR/server.pid"

if [ -f "$PID_FILE" ]; then
  EXISTING_PID=$(cat "$PID_FILE")
  if kill -0 "$EXISTING_PID" >/dev/null 2>&1; then
    echo "[deploy] 检测到已有运行中的服务 (PID=$EXISTING_PID)，请先执行 ./stop.sh 再启动。"
    exit 1
  else
    echo "[deploy] 检测到过期的 PID 文件，自动清理。"
    rm -f "$PID_FILE"
  fi
fi

echo "[deploy] 安装依赖..."
npm install >/dev/null 2>&1 && echo "[deploy] 依赖已就绪。"

PORT="${PORT:-1666}"
echo "[deploy] 启动 MCP 搜索服务 (port=$PORT)，日志输出到 $LOG_FILE"
PORT="$PORT" node src/server.js >>"$LOG_FILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PID_FILE"

echo "[deploy] 服务已启动 (PID=$NEW_PID)。使用 tail -f $LOG_FILE 查看实时日志。"
