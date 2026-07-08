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

FusionSearch MCP 是一个五层搜索融合服务，把官方 LibreSearch 镜像、Search-2api/search.sh、Grok/OpenAI-compatible、Tavily 和 Firecrawl 收进同一个 MCP 项目里。它吸收了 Grok Search MCP 的“双引擎 + 抓取降级”思路，但默认用 `/mcp` 做统一入口，并把网页搜索、答案搜索、AI 汇总、网页抓取、站点映射和自监控放在同一套工具暴露里。

它同时提供：

- 搜索引擎网页：all-in-one 模式下根路径 `/` 是官方 LibreSearch 搜索页。
- 管理 UI：`/admin` 配置 LibreSearch、Search-2api、All Key Control、System Prompt 和 Token，并提供五类能力测试页。
- MCP：`/mcp` 给 Cherry Studio、Claude Code、Codex 等客户端调用；旧 profile 路由仅保留兼容。
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
| `/mcp` | 统一 Fusion MCP，推荐默认使用 | 统一 Fusion MCP，推荐默认使用 |
| `/libresearch/mcp` | legacy 兼容 profile | legacy 兼容 profile |
| `/fusion/mcp` | legacy 兼容 profile | legacy 兼容 profile |
| `/search2api/v1/chat/completions` | 通常外置，不由本服务提供 | 内置 Search-2api OpenAI-compatible endpoint |

## Fusion Orchestrator 证据流水线架构

FusionSearch 当前以 `/mcp` 为统一入口运行 Fusion Orchestrator。它不是把多个 provider 简单并列暴露给客户端，而是把一次查询拆成意图识别、provider 编排、证据归一、去重排序、交叉校验和最终合成几步，让客户端默认拿到可追踪的答案、来源和 provider 状态。

```text
Client / LLM
  └─ MCP: /mcp
      ├─ 推荐入口: smart_research / smart_fetch / fusion_status
      │
      └─ Fusion Orchestrator
          ├─ Intent Router
          │   ├─ URL 输入 -> 抓取流水线
          │   └─ 关键词/问题 -> 多源研究流水线
          ├─ Provider Registry
          │   ├─ LibreSearch/SearXNG: 结构化网页结果
          │   ├─ Search-2api/search.sh: 答案型搜索
          │   ├─ Tavily: search / extract / map
          │   ├─ Firecrawl: 正文抓取托底
          │   └─ Grok/OpenAI-compatible: 合成与总结
          ├─ Evidence Normalizer
          │   └─ 统一 title、url、description、provider、content、状态与错误
          ├─ Dedup / Ranking / Cross-check
          │   ├─ 合并重复 URL 与相近来源
          │   ├─ 优先保留多 provider 支持的证据
          │   └─ 标记单源、失败源和证据不足的结论
          └─ Synthesis
              ├─ 生成面向用户的问题答案
              ├─ 附带证据摘要与来源列表
              └─ 上游失败时仍返回已取得证据和明确错误
```

当前推荐客户端优先调用 `smart_research`、`smart_fetch` 和 `fusion_status`。`smart_research` 负责从 URL 或自然语言问题进入合适流水线；`smart_fetch` 负责 URL 抓取、降级和可选总结；`fusion_status` 负责查看 LibreSearch、Search-2api、Grok、Tavily、Firecrawl 的健康状态与脱敏配置状态。

除三类智能工具外，还有三个配置/运维工具：`web_map`（Tavily 站点地图）、`fusion_config`（Grok/Tavily/Firecrawl 配置诊断，可选连通性测试）、`fusion_switch_model`（切换默认 Grok 模型并持久化）。工具总数从 22 精简到 6，原先重叠的 `libresearch_*` / `fusionsearch_*` 家族与单独的 provider 工具已移除，取证与编排全部收进服务端。

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

仓库已带 GitHub Actions：推送 `main` 后会自动构建并发布 `ghcr.io/zhizhishu/fusionsearch-mcp:latest`，同时生成 `sha-*` 标签。服务器端只需要 `docker pull` 或重新 `docker compose pull && docker compose up -d` 即可更新。

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

GROK_API_URL=<可选，显式 OpenAI-compatible /v1 地址>
GROK_API_KEY=<可选>
TAVILY_PROVIDER=rest
TAVILY_API_KEY=<可选，官方 Tavily REST key>
TAVILY_MCP_URL=<可选，第三方 Tavily MCP 地址，例如 Hikari>
TAVILY_MCP_TOKEN=<可选，第三方 Tavily MCP Bearer Token>
TAVILY_HIKARI_TOKEN=<可选，Hikari Token 兼容别名>
FIRECRAWL_API_KEY=<可选>
```

不要把 Cookie、API Key、Admin Token、MCP Token 提交到 GitHub 或 Hugging Face 文件里。它们只应该放在 `.env`、服务器环境变量或 HF Secrets。

### Admin UI 回写 Hugging Face Secrets

`/admin` 现在可以直接替换 Hugging Face Space Secrets。推荐先配置：

```text
HF_SPACE_ID=alphaeee/fusionsearch-mcp
HF_WRITE_TOKEN=<有该 Space 写权限的 Hugging Face token>
```

如果运行中的容器还没有 `HF_WRITE_TOKEN`，可以在 `/admin -> 安全 -> HF Secrets -> 一次性 HF Write Token` 里临时粘贴一次。UI 也可以把 `HF_WRITE_TOKEN` 自己保存成 Space Secret，方便后续继续改。已有 Secret 值不会回显；留空字段会被忽略。

替换 Secret 后，重启 Space 让容器重新读取环境变量。`ADMIN_TOKEN`、`SESSION_SECRET`、`MCP_AUTH_TOKEN` 在 UI 保存成功后也会同步到当前运行时：如果改了 Admin Token 或 Session Secret，当前登录会失效，需要用新口令重新登录。Admin/MCP Token 不限制固定长度，短口令可用，但公网环境仍建议使用长随机值。安全页已经登录后即可修改 Token，“当前 Admin Token”只是可选确认项，可以留空。

如果只在 `/admin -> 安全` 改 Admin Token，但没有同步写入 HF Secrets，Space 重启时会重新读取 `ADMIN_TOKEN` 环境变量，所以口令会恢复成 HF Secrets 里的旧值。新版安全页默认勾选“同步写入 Hugging Face Secrets”；只要 `HF_WRITE_TOKEN` 已配置，或临时粘贴一次性 HF token，改口令就会同时更新 Space Secret，重启后不会回退。

### 第三方 Tavily MCP / Hikari

FusionSearch 支持两种 Tavily 来源：

- `TAVILY_PROVIDER=rest`：走 Tavily REST，使用 `TAVILY_API_URL` / `TAVILY_API_KEY`；`TAVILY_API_URL` 默认 `https://api.tavily.com`，也可以换成自定义代理地址。
- `TAVILY_PROVIDER=mcp`：走第三方 Tavily MCP/Hikari，使用 `TAVILY_MCP_URL` / `TAVILY_MCP_TOKEN`。如果只设置了 `TAVILY_HIKARI_TOKEN` 且未指定 provider，服务会自动切到 MCP 模式，并默认使用 `https://tavily.ivanli.cc/mcp`。

Admin UI 的 Tavily 页是二选一：`官方 REST` 显示 REST API URL/Key，`自定义 MCP / Hikari` 显示 MCP URL/Token 与工具名覆盖。MCP 模式会自动发现 search / extract / map 工具；第三方网关工具名特殊时，可设置 `TAVILY_MCP_SEARCH_TOOL`、`TAVILY_MCP_EXTRACT_TOOL`、`TAVILY_MCP_MAP_TOOL` 覆盖。

### Admin 日志

`/admin -> 状态 -> 日志` 可以查看 FusionSearch 自身运行日志，默认写入 `logs/fusionsearch.log`。日志会记录配置保存、安全设置、HF Secrets 更新和 Admin API 错误；Token、Cookie、API Key 等敏感字段会脱敏。

## MCP 工具

工具精简为 6 个。智能工具在服务端自动编排 LibreSearch、Search-2api、Grok、Tavily、Firecrawl 五层能力并交叉取证，客户端不必在一堆同义工具里挑选：

- `smart_research`：推荐主入口。Intent Router 会先判断输入是 URL 还是关键词/问题；URL 进入抓取流水线，关键词/问题进入多源研究流水线，并尽量交叉取证后再合成答案。可用 `strategy` 选档位、`limit`（extra_sources）扩展信源。
- `smart_fetch`：推荐网页抓取入口。按 `Tavily Extract -> Firecrawl Scrape -> HTML fetch` 顺序降级，归一化正文证据后可选让 Grok 基于抓取内容总结。
- `web_map`：Tavily Map 探测站点结构与链接。
- `fusion_status`：返回 LibreSearch、Search-2api、Grok、Tavily、Firecrawl 的最近健康状态和脱敏 Key 状态。
- `fusion_config`：Grok/Tavily/Firecrawl 配置诊断，可选实时连通性测试。
- `fusion_switch_model`：切换默认 Grok 模型并持久化到 runtime 配置。

> v2 起工具从 22 精简到 6：重叠的 `libresearch_*` / `fusionsearch_*` 家族与单独的 `web_search`/`web_fetch`/`fusion_research` provider 工具已移除，取证与多源编排收进服务端 Fusion Orchestrator。Grok 合成默认走流式（连接不空闲，绕开中转代理约 60 秒空闲掐断长请求），失败自动降级非流式。

统一 MCP 入口：

- `/mcp`：全量 FusionSearch MCP，日常推荐。
- `/libresearch/mcp` 与 `/fusion/mcp`：legacy profile 路由，只为旧客户端配置兼容保留。

公网 MCP 建议开启 `MCP_AUTH_TOKEN`，客户端使用：

```text
Authorization: Bearer <MCP_AUTH_TOKEN>
```

如果某些 MCP 客户端不好填 Header，也支持便捷路径鉴权：

```text
https://<host>/mcp/ApiKey=<MCP_AUTH_TOKEN>
```

SSE 客户端可用：

```text
https://<host>/mcp/ApiKey=<MCP_AUTH_TOKEN>/sse
```

注意：URL 里的 Token 可能出现在浏览器历史、反向代理访问日志或截图里；生产环境仍优先推荐 Bearer Header。

## Admin UI

打开：

```text
http://<host>:1666/admin
```

管理页可以配置：

- LibreSearch/SearXNG endpoint 与默认参数，默认强制 `format=json`。
- Search-2api endpoint 与 Bearer Token。
- All Key Control：集中填写 Grok/OpenAI-compatible、Tavily、Firecrawl，并显示脱敏 Key 状态。
- Grok/OpenAI-compatible URL、Key、模型。
- Grok 默认模型：保存时可同步 `GROK_MODEL` 到 Hugging Face Secrets，避免 Space 重启后恢复旧模型。
- Grok System Prompt：真正随请求发给 Grok 的 `system` message。
- Tavily 与 Firecrawl Key/API URL，Tavily 页提供官方 REST 与自定义 MCP/Hikari 二选一配置。
- Admin Token、Session Secret、MCP Token 轮换。

All Key Control 会显示 `已配置 / 未配置`、脱敏值和来源，例如 `sk-****1234`、`cf_clearance=****; len 392`。完整 Cookie、Token、API Key 不会回显，也不会写入日志。

状态页新增 `Monitoring`：按 CheckCle 式服务列表展示 LibreSearch、Search-2api、Grok、Tavily、Firecrawl 的 `Up / Warning / Down / Paused`。它优先依赖最近 MCP 调用、Admin 测试和日志记录；主动探针有 10 分钟冷却保护，Tavily/Firecrawl 默认不主动消耗额度，只确认配置并等待真实调用刷新状态。

测试页分为 LibreSearch、Search-2api、Grok、Tavily、Firecrawl 五个标签：LibreSearch 验证 JSON 搜索；Search-2api 验证 Chat Completions 和上游维护状态；Grok 验证模型/回答；Tavily 验证 Search、Fetch、Map；Firecrawl 验证 Scrape 托底。

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
| `LOG_DIR` | FusionSearch 日志目录，默认 `./logs` |
| `ADMIN_AUTH_ENABLED` | 是否启用 Admin Token |
| `ADMIN_TOKEN` | 管理页登录口令 |
| `SESSION_SECRET` | session cookie 签名密钥 |
| `MCP_AUTH_TOKEN` | MCP Bearer Token |
| `HF_ENDPOINT` | Hugging Face Hub 地址，默认 `https://huggingface.co` |
| `HF_SPACE_ID` / `SPACE_ID` | 允许 `/admin` 回写 Secrets 的 Space ID，例如 `alphaeee/fusionsearch-mcp` |
| `HF_WRITE_TOKEN` | 允许 `/admin` 调 Hugging Face API 替换 Space Secrets 的写入 token |
| `SEARCH_SH_CHAT_ENDPOINT` | 外置 Search-2api chat completions 地址 |
| `SEARCH_SH_API_KEY` | 外置 Search-2api Bearer Token |
| `SEARCH_SH_COOKIE` | 内置 Search-2api 调 search.sh 的 Cookie |
| `SEARCH_SH_USER_AGENT` | 内置 Search-2api 调 search.sh 的 User-Agent |
| `API_MASTER_KEY` | 内置 Search-2api 的 Bearer Token |
| `GROK_API_URL` | OpenAI-compatible Grok `/v1` 地址 |
| `GROK_API_KEY` | Grok API Key |
| `GROK_MODEL` | 默认 Grok 模型 |
| `GROK_SYSTEM_PROMPT` | 注入给 Grok 的 system prompt |
| `TAVILY_ENABLED` | 是否启用 Tavily |
| `TAVILY_PROVIDER` | `rest` 或 `mcp`；未设置时默认 REST，检测到 Hikari/MCP token 时自动使用 MCP |
| `TAVILY_API_URL` / `TAVILY_API_KEY` | 官方 Tavily REST 配置 |
| `TAVILY_MCP_URL` / `TAVILY_MCP_TOKEN` | 第三方 Tavily MCP/Hikari 配置 |
| `TAVILY_HIKARI_TOKEN` | Hikari Bearer Token 兼容别名 |
| `TAVILY_MCP_SEARCH_TOOL` / `TAVILY_MCP_EXTRACT_TOOL` / `TAVILY_MCP_MAP_TOOL` | 第三方 MCP 工具名覆盖，通常留空自动发现 |
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
