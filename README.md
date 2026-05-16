---
title: FusionSearch MCP
emoji: 🔎
colorFrom: gray
colorTo: blue
sdk: docker
app_port: 1666
pinned: false
license: mit
short_description: LibreSearch, Search-2api, Grok, Tavily and Firecrawl MCP
---

# FusionSearch MCP

FusionSearch MCP 是一个搜索聚合服务，把官方 LibreSearch 镜像、Search-2api/search.sh、Grok/OpenAI-compatible、Tavily 和 Firecrawl 收进同一个 MCP 项目里。

它同时提供：

- 搜索引擎网页：all-in-one 模式下根路径 `/` 是官方 LibreSearch 搜索页。
- 管理 UI：`/admin` 配置 LibreSearch、Search-2api、Grok/GuDa、Tavily、Firecrawl、System Prompt 和 Token。
- MCP：`/mcp`、`/libresearch/mcp`、`/fusion/mcp` 给 Cherry Studio、Claude Code、Codex 等客户端调用。
- Search-2api OpenAI-compatible API：all-in-one 模式下 `/search2api/v1/chat/completions`。

## 部署模式

| 模式 | 适合场景 | 入口 |
| --- | --- | --- |
| 正常服务器版 | 只跑 FusionSearch MCP/UI，LibreSearch 与 Search-2api 可外置 | `docker compose up -d --build` |
| Docker Compose 多合一 | 一台服务器里同时跑 Nginx + FusionSearch + 官方 LibreSearch 镜像 + Search-2api | `docker compose -f docker-compose.all-in-one.yml up -d --build` |
| Hugging Face 多合一 | 一个 public Docker Space 同时提供搜索页、Admin UI、MCP 和 Search-2api | 用 `Dockerfile.hf-allinone` 作为 Space 的 `Dockerfile` |

## 路径

| 路径 | 正常服务器版 | 多合一版 / Hugging Face 版 |
| --- | --- | --- |
| `/` | Streamable HTTP MCP 兼容入口，浏览器访问会跳到 `/admin` | LibreSearch 搜索首页 |
| `/search` | 由 `SEARCH_ENDPOINT` 指向外部搜索 API | LibreSearch 搜索 API，支持 `format=json` |
| `/admin` | FusionSearch 管理 UI | FusionSearch 管理 UI |
| `/mcp` | 全量 MCP，推荐默认使用 | 全量 MCP，推荐默认使用 |
| `/libresearch/mcp` | LibreSearch/Search-2api 搜索工具 profile | LibreSearch/Search-2api 搜索工具 profile |
| `/fusion/mcp` | Grok/Tavily/Firecrawl/Fusion profile | Grok/Tavily/Firecrawl/Fusion profile |
| `/search2api/v1/chat/completions` | 通常外置，不由本服务提供 | 内置 Search-2api OpenAI-compatible endpoint |

## 正常服务器版

这种模式最轻，只运行 FusionSearch Node 服务。LibreSearch 可以继续外置 Hugging Face，也可以填你自己的 LibreSearch/Search-2api 地址。

```bash
git clone https://github.com/zhizhishu/fusionsearch-mcp.git
cd fusionsearch-mcp
cp .env.example .env
docker compose up -d --build
docker compose logs -f fusionsearch-mcp
```

默认入口：

```text
Admin:  http://<server-ip>:1666/admin
MCP:    http://<server-ip>:1666/mcp
Health: http://<server-ip>:1666/health
```

也可以直接使用 GHCR 镜像：

```bash
docker pull ghcr.io/zhizhishu/fusionsearch-mcp:latest
docker run -d \
  --name fusionsearch-mcp \
  -p 1666:1666 \
  -e PORT=1666 \
  -e RUNTIME_CONFIG_PATH=/app/config/runtime.json \
  -v "$(pwd)/config:/app/config" \
  -v "$(pwd)/logs:/app/logs" \
  --restart unless-stopped \
  ghcr.io/zhizhishu/fusionsearch-mcp:latest
```

## Docker Compose 多合一

这种模式会在服务器里一次启动四个服务：

```text
gateway/nginx
  ├─ /                  -> libresearch:8080
  ├─ /search            -> libresearch:8080/search
  ├─ /admin /mcp /api   -> fusionsearch-mcp:1666
  └─ /search2api/*      -> search2api:8000/*
```

其中 `libresearch` 服务直接使用 `libregroup/libresearch:latest`，不再从源码重复构建 SearXNG。`deploy/searxng/settings.yml` 只作为轻量配置文件挂载，确保 `format=json` 长期可用。
Nginx 使用 Docker 内置 DNS 动态解析服务名，`fusionsearch-mcp`、`libresearch` 或 `search2api` 单独重启后不会继续指向旧容器 IP。

启动：

```bash
cp .env.example .env
# 编辑 .env，至少建议设置 ADMIN_TOKEN、SESSION_SECRET、MCP_AUTH_TOKEN。
# Search-2api 需要 SEARCH_SH_COOKIE；很多情况下还需要 SEARCH_SH_USER_AGENT 与 Cookie 匹配。
docker compose -f docker-compose.all-in-one.yml up -d --build
docker compose -f docker-compose.all-in-one.yml logs -f
```

默认入口：

```text
Search:      http://<server-ip>:1666/
Search JSON: http://<server-ip>:1666/search?q=test&format=json
Admin:       http://<server-ip>:1666/admin
MCP:         http://<server-ip>:1666/mcp
Search-2api: http://<server-ip>:1666/search2api/v1/chat/completions
```

停止：

```bash
docker compose -f docker-compose.all-in-one.yml down
```

## Hugging Face 多合一

Hugging Face Docker Space 版使用单容器多进程，最终镜像直接 `FROM libregroup/libresearch:latest`：

```text
Hugging Face public Space
  └─ Dockerfile.hf-allinone
       ├─ libregroup/libresearch:latest
       ├─ node src/server.js 作为轻量网关与 MCP/Admin 服务
       ├─ LibreSearch / granian
       └─ search2api FastAPI
```

HF 只有一个容器，所以这里不再装 Nginx/Supervisor；启动脚本会同时拉起 LibreSearch、Search-2api 和 FusionSearch Node。Node 网关负责把 `/`、`/search`、`/static` 代理到 LibreSearch，把 `/search2api/*` 代理到 Search-2api。

Hugging Face Space 只会自动识别根目录 `Dockerfile`。所以部署 Space 时有两种做法：

1. 在 Space 仓库里把 `Dockerfile.hf-allinone` 复制/改名为 `Dockerfile`。
2. 用同步脚本或 CI 推送到 HF Space 时，把 `Dockerfile.hf-allinone` 映射成 Space 根目录的 `Dockerfile`。

Space Settings 里建议配置这些 Secrets/Variables：

```text
ADMIN_AUTH_ENABLED=true
ADMIN_TOKEN=<管理页登录口令>
SESSION_SECRET=<随机长字符串>
MCP_AUTH_TOKEN=<MCP Bearer Token>

SEARCH_SH_COOKIE=<从 search.sh 浏览器 Network 请求复制的完整 cookie header>
SEARCH_SH_USER_AGENT=<复制 cookie 时同一个浏览器请求的 User-Agent>
API_MASTER_KEY=<Search-2api 内部 Bearer Token>

GUDA_BASE_URL=https://code.guda.studio
GUDA_API_KEY=<可选，统一派生 Grok/Tavily/Firecrawl>
GROK_API_URL=<可选，显式 OpenAI-compatible /v1 地址>
GROK_API_KEY=<可选>
TAVILY_API_KEY=<可选>
FIRECRAWL_API_KEY=<可选>
```

不要把 Cookie、API Key、Admin Token、MCP Token 提交到 GitHub 或 Hugging Face 文件里。它们只应该放在 `.env`、服务器环境变量或 HF Secrets。

### Admin UI 回写 Hugging Face Secrets

`/admin` 现在可以直接替换 Hugging Face Space Secrets。推荐先配置：

```text
HF_SPACE_ID=Echocq/fusionsearch-mcp
HF_WRITE_TOKEN=<有该 Space 写权限的 Hugging Face token>
```

如果运行中的容器还没有 `HF_WRITE_TOKEN`，可以在 `/admin -> 安全 -> HF Secrets -> 一次性 HF Write Token` 里临时粘贴一次。UI 也可以把 `HF_WRITE_TOKEN` 自己保存成 Space Secret，方便后续继续改。已有 Secret 值不会回显；留空字段会被忽略。

替换 Secret 后，重启 Space 让容器重新读取环境变量。

## MCP 工具

推荐新工具名少而准：

- `web_search`：Grok/OpenAI-compatible AI 搜索/回答，使用 Admin UI 里配置的 Grok System Prompt。
- `web_fetch`：Tavily Extract 抓正文，失败或空内容时降级 Firecrawl Scrape。
- `web_map`：Tavily Map 做站点地图。
- `libre_search`：LibreSearch/SearXNG JSON 结构化搜索。
- `search2api_chat`：调用 Search-2api/search.sh 返回答案。
- `fusion_research`：LibreSearch + Search-2api 取证，再交给 Grok 汇总。

兼容旧工具仍保留：

- `fusionsearch_*`
- `libresearch_*`

三个 MCP 入口的区别：

- `/mcp`：全量工具，日常推荐。
- `/libresearch/mcp`：只暴露 LibreSearch/Search-2api 相关搜索工具。
- `/fusion/mcp`：只暴露 Grok/Tavily/Firecrawl/Fusion 相关工具。

公网 MCP 建议开启 `MCP_AUTH_TOKEN`，客户端使用：

```text
Authorization: Bearer <MCP_AUTH_TOKEN>
```

## Admin UI

打开：

```text
http://<host>:1666/admin
```

管理页可以配置：

- LibreSearch/SearXNG endpoint 与默认参数，默认强制 `format=json`。
- Search-2api endpoint 与 Bearer Token。
- GuDa Base URL 与 GuDa Key。
- Grok/OpenAI-compatible URL、Key、模型。
- Grok System Prompt：真正随请求发给 Grok 的 `system` message。
- Tavily 与 Firecrawl Key/API URL。
- Admin Token、Session Secret、MCP Token 轮换。

环境变量优先级高于 `config/runtime.json`。Key 类字段只显示“是否已配置”，不会在 API 响应或页面里回显明文。

## Search-2api 注意事项

Search-2api 来源项目：<https://github.com/lza6/Search-2api>。

它依赖 search.sh 浏览器请求里的临时 Cookie。实测重点：

- `SEARCH_SH_COOKIE` 要从浏览器 Network 请求复制完整 cookie header。
- `cf_clearance` 通常和 User-Agent 绑定，建议同时填写 `SEARCH_SH_USER_AGENT`。
- Cookie 过期或 search.sh 上游接口变化时，Search-2api 会失效，需要重新抓 Cookie。
- 如果设置 `API_MASTER_KEY`，FusionSearch 侧需要用相同值作为 `SEARCH_SH_API_KEY`。多合一 compose 已自动把 `API_MASTER_KEY` 传给 FusionSearch。
- 没填 Cookie 时，内置 Search-2api 仍会启动，`/v1/models` 可探针通过；真正调用 chat 时会返回明确的 503 缺 Cookie 提示。

测试：

```bash
curl http://localhost:1666/search2api/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <API_MASTER_KEY>" \
  -d '{"model":"search-sh-ai","messages":[{"role":"user","content":"你好"}],"stream":false}'
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `FUSIONSEARCH_PORT` | Compose 对外端口，默认 `1666` |
| `PORT` | 容器内 FusionSearch 监听端口 |
| `SEARCH_ENDPOINT` | LibreSearch `/search` API 地址 |
| `RUNTIME_CONFIG_PATH` | 运行配置保存路径 |
| `ADMIN_AUTH_ENABLED` | 是否启用 Admin Token |
| `ADMIN_TOKEN` | 管理页登录口令 |
| `SESSION_SECRET` | session cookie 签名密钥 |
| `MCP_AUTH_TOKEN` | MCP Bearer Token |
| `HF_ENDPOINT` | Hugging Face Hub 地址，默认 `https://huggingface.co` |
| `HF_SPACE_ID` / `SPACE_ID` | 允许 `/admin` 回写 Secrets 的 Space ID，例如 `Echocq/fusionsearch-mcp` |
| `HF_WRITE_TOKEN` | 允许 `/admin` 调 Hugging Face API 替换 Space Secrets 的写入 token |
| `SEARCH_SH_CHAT_ENDPOINT` | 外置 Search-2api chat completions 地址 |
| `SEARCH_SH_API_KEY` | 外置 Search-2api Bearer Token |
| `SEARCH_SH_COOKIE` | 内置 Search-2api 调 search.sh 的 Cookie |
| `SEARCH_SH_USER_AGENT` | 内置 Search-2api 调 search.sh 的 User-Agent |
| `API_MASTER_KEY` | 内置 Search-2api 的 Bearer Token |
| `GUDA_BASE_URL` | GuDa 统一入口地址 |
| `GUDA_API_KEY` | GuDa Key，可派生 Grok/Tavily/Firecrawl |
| `GROK_API_URL` | OpenAI-compatible Grok `/v1` 地址 |
| `GROK_API_KEY` | Grok API Key |
| `GROK_MODEL` | 默认 Grok 模型 |
| `GROK_SYSTEM_PROMPT` | 注入给 Grok 的 system prompt |
| `TAVILY_ENABLED` | 是否启用 Tavily |
| `TAVILY_API_URL` / `TAVILY_API_KEY` | Tavily 配置 |
| `FIRECRAWL_API_URL` / `FIRECRAWL_API_KEY` | Firecrawl 配置 |
| `GRANIAN_WORKERS` / `GRANIAN_BLOCKING_THREADS` | 官方 LibreSearch 镜像的 Granian 并发参数 |
| `GRANIAN_PROCESS_NAME` | LibreSearch 运行进程名，默认 `fusionsearch-libre`，避免部分托管平台误判默认进程名 |
| `UWSGI_WORKERS` / `UWSGI_THREADS` | 兼容旧 LibreSearch 运行习惯的环境变量，保留给部署层填写 |

## 本地开发

```bash
npm install
npm run dev
```

静态检查：

```bash
node --check src/app.js
node --check src/fusionClients.js
node --check src/server.js
node --check public/admin/app.js
python -m py_compile services/search2api/main.py services/search2api/app/core/config.py services/search2api/app/providers/search_provider.py
docker compose -f docker-compose.all-in-one.yml config
```

## 设计原则

- KISS：普通服务器版保持轻量；all-in-one 直接复用官方 LibreSearch 镜像，不再重复构建搜索引擎。
- YAGNI：当前只做 Token 鉴权，不把 HF OAuth 做成强依赖。
- DRY：Grok/Tavily/Firecrawl 配置集中在 Fusion client，LibreSearch/Search-2api 各自独立，搜索引擎运行时复用 `libregroup/libresearch`。
- SOLID：Admin UI、MCP 工具注册、搜索客户端、鉴权、运行配置分离，后续换接口时不需要重写整套服务。
