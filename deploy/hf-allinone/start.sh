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

# 修补 SearXNG settings（始终执行，与是否配代理无关）：
#  ① server.method=GET —— 网页端搜索改走 URL query 提交。根因：node 反代 /search 的 POST
#     表单 body 没透传到内部 SearXNG，网页端每次搜索都空跑返回首页("输入没反应")；
#     GET 让 q 进 URL query 绕开(实测 GET/querystring 路径正常)。只改网页表单默认方法，
#     不影响 MCP libre 路(直连 8080 的 POST 照收)。
#  ② 代理策略(per-engine 精细优先)：配了 SEARXNG_ENGINE_PROXY_URL → 全局直连(mwmbl/wikipedia/
#     bing 不吃 IP、直连消掉代理抖动的偶发0)，只给"挑 IP"引擎(mojeek/qwant/yep/presearch)挂干净
#     出口轮询(mojeek 靠干净 IP 绕黑名单)；否则配了 SEARXNG_PROXY_URL 走全局代理(旧行为)；都没配全直连。
#  ③ 引擎换血(SEARXNG_ENGINE_TUNING != off 时)：镜像默认关掉了 mojeek/qwant/mwmbl/yep/
#     presearch/bing 这些对机房 IP 友好的通用引擎，而开着的主力(google/ddg/startpage)恰恰
#     对机房 IP 最凶、一直被封。这里纯增启那几个友好引擎(只增不减、不动现有引擎)，增加稳定
#     结果源。出问题设 HF 变量 SEARXNG_ENGINE_TUNING=off + 重启即回退(不必 rebuild)。
# 失败(路径/yaml 异常)只告警不阻断启动，SearXNG 退回镜像默认(不会比现在更糟)。
echo "[fusionsearch] patching searxng settings (method=GET; proxies if set; engine tuning)"
SEARXNG_SETTINGS_FILE="${__SEARXNG_SETTINGS_PATH:-/etc/searxng/settings.yml}" \
SEARXNG_PROXY_URL="${SEARXNG_PROXY_URL:-}" \
SEARXNG_ENGINE_PROXY_URL="${SEARXNG_ENGINE_PROXY_URL:-}" \
SEARXNG_ENGINE_TUNING="${SEARXNG_ENGINE_TUNING:-on}" \
  /usr/local/searxng/.venv/bin/python3 - <<'PYEOF' || echo "[fusionsearch] WARN: searxng settings patch failed; using image defaults"
import os, sys, yaml
path = os.environ.get('SEARXNG_SETTINGS_FILE', '/etc/searxng/settings.yml')
try:
    with open(path) as f:
        cfg = yaml.safe_load(f) or {}
except FileNotFoundError:
    print('[fusionsearch] settings file not found: %s (skip patch)' % path)
    sys.exit(0)

# ① 网页端搜索表单走 GET(q 进 URL query)，绕开反代不透传 POST body 的问题。
#    注意：SearXNG 的搜索方法配置键是 server.method(默认 POST)，不是 search.method。
cfg.setdefault('server', {})['method'] = 'GET'

# ② 代理策略(per-engine 精细优先)：见顶部注释②
engine_proxies = [u.strip() for u in os.environ.get('SEARXNG_ENGINE_PROXY_URL', '').split(',') if u.strip()]
global_proxies = [u.strip() for u in os.environ.get('SEARXNG_PROXY_URL', '').split(',') if u.strip()]
if engine_proxies:
    picky = ['mojeek', 'qwant', 'yep', 'presearch']
    _engs = cfg.setdefault('engines', [])
    if not isinstance(_engs, list):
        _engs = []
        cfg['engines'] = _engs
    _by = {e.get('name'): e for e in _engs if isinstance(e, dict) and e.get('name')}
    for nm in picky:
        e = _by.get(nm)
        if e is None:
            e = {'name': nm}
            _engs.append(e)
            _by[nm] = e
        e['proxies'] = {'all://': engine_proxies}
        e['disabled'] = False
    proxy_mode = 'per-engine(%d exits)' % len(engine_proxies)
elif global_proxies:
    out = cfg.setdefault('outgoing', {})
    out['proxies'] = {'all://': global_proxies}
    out['request_timeout'] = 10.0
    out['max_request_timeout'] = 20.0
    proxy_mode = 'global(%d)' % len(global_proxies)
else:
    proxy_mode = 'direct'

# ③ 引擎换血：增启对机房 IP 友好、但镜像默认禁用的通用引擎(纯增不减，好回退)。
#    这些引擎名取自线上 /config 实测(SearXNG 内置)，用 disabled=False override 默认。
tuned = []
if os.environ.get('SEARXNG_ENGINE_TUNING', 'on').strip().lower() != 'off':
    tuned = ['mojeek', 'qwant', 'mwmbl', 'yep', 'presearch', 'bing']
    engines = cfg.get('engines')
    if not isinstance(engines, list):
        engines = []
        cfg['engines'] = engines
    by_name = {e.get('name'): e for e in engines if isinstance(e, dict) and e.get('name')}
    for nm in tuned:
        if nm in by_name:
            by_name[nm]['disabled'] = False
        else:
            engines.append({'name': nm, 'disabled': False})

with open(path, 'w') as f:
    yaml.dump(cfg, f, default_flow_style=False, allow_unicode=True)
print('[fusionsearch] searxng settings patched: method=GET, proxy_mode=%s, engines_enabled=%s' % (proxy_mode, tuned))
PYEOF

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
