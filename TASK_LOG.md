# TASK_LOG

## 接力摘要

- 当前目标：将官方 LibreSearch 镜像接入 FusionSearch，作为 Docker Compose 多合一与 Hugging Face all-in-one 的长期运行依赖。
- 已完成：新增推荐 MCP 工具 `web_search`、`web_fetch`、`web_map`、`libre_search`、`search2api_chat`、`fusion_research`，保留旧 `fusionsearch_*` / `libresearch_*`；新增 Grok System Prompt 配置与 Admin UI 编辑；新增内置 Search-2api FastAPI 服务、Compose gateway、HF start 脚本和 `Dockerfile.hf-allinone`；Docker Compose 多合一路由已改成 `/` 搜索页，`/admin`、`/mcp`、`/api` 走 FusionSearch，`/search2api/*` 走 Search-2api；Compose 多合一已将搜索引擎服务改为 `libregroup/libresearch:latest`；HF all-in-one 最终镜像已直接 `FROM libregroup/libresearch:latest`，通过复制 Node runtime 与启动脚本同时运行 LibreSearch、FusionSearch、Search-2api；HF 版不再安装 Nginx/Supervisor；Compose Nginx 已改成 Docker DNS 动态解析，服务单独重启后不握旧 IP；Search-2api 没填 Cookie 时仍可启动并让 `/v1/models` 探针通过，chat 调用返回明确 503；`README.md` 已重写为正常服务器版、Docker Compose 多合一、Hugging Face 多合一三条路线；Admin UI 已新增 `Security -> HF Secrets`，可通过 `HF_WRITE_TOKEN` 或一次性 HF token 直接替换 Space Secrets；本轮已放宽 Admin/MCP Token 长度限制，拆分 Admin 与 MCP 密钥更新逻辑，并新增 `状态 -> 日志` 与 `/api/admin/logs`。
- 下一步：用户已明确授权删除重建 HF Space。旧 `Echocq/fusionsearch-mcp` 已删除，同名 public Docker Space 已重建并通过 Browser Relay 分片 commit 写入当前 all-in-one 代码，线上最新 HF commit 为 `c6700dee1d1815a99c59af0c0a3b6b0e3ef4696b`。重建后 HF Secrets 已恢复（只记录键名，不记录值）：`ADMIN_TOKEN`、`SESSION_SECRET`、`MCP_AUTH_TOKEN`、`HF_SPACE_ID`、`SEARCH_SH_COOKIE`、`SEARCH_SH_USER_AGENT`、`API_MASTER_KEY`、`GROK_API_URL`、`GROK_API_KEY`、`GROK_SYSTEM_PROMPT`、`FIRECRAWL_API_KEY`、`TAVILY_HIKARI_TOKEN`、`TAVILY_ENABLED`。`ADMIN_TOKEN` 按用户要求临时设为 `admin`；`SESSION_SECRET`、`MCP_AUTH_TOKEN`、`API_MASTER_KEY` 为重建时新生成随机值。
- 关键文件：`src/app.js`、`src/fusionClients.js`、`src/server.js`、`public/admin/index.html`、`public/admin/style.css`、`public/admin/app.js`、`services/search2api/*`、`deploy/nginx/all-in-one.conf`、`deploy/hf-allinone/start.sh`、`deploy/searxng/settings.yml`、`Dockerfile.hf-allinone`、`docker-compose.yml`、`docker-compose.all-in-one.yml`、`.env.example`、`README.md`、`THIRD_PARTY_NOTICES.md`。
- 验证结果：`node --check src/app.js src/fusionClients.js src/server.js public/admin/app.js` 通过；`python -m py_compile services/search2api/main.py services/search2api/app/core/config.py services/search2api/app/providers/search_provider.py` 通过；`docker compose -f docker-compose.all-in-one.yml config` 通过；`nginx -t` 通过；`docker build -f Dockerfile.hf-allinone -t fusionsearch-hf-allinone:libresearch .` 通过；HF 单容器临时端口 `18088` 验证 `/health` 200、`/` 200、`/search?format=json` 200、`/search2api/v1/models` 200、缺 Cookie chat 503；Compose 多合一临时端口 `18087` 验证 `/health` 200、`/` 200、`/search?format=json` 200、`/search2api/v1/models` 200、缺 Cookie chat 503；Compose 单独重启 `fusionsearch-mcp` 与 `search2api` 后 `/health` 与 `/search2api/v1/models` 仍 200；Hugging Face 重建后线上 runtime 为 `RUNNING`，验证 `/health` 200、`/` 200、`/search?format=json` 200、`/search2api/v1/models` 200、`/admin` 200、`/api/admin/login` 200、未带 Bearer 访问 `/mcp` 返回 401；本轮临时端口 `18091` 验证短 Admin Token `x` 可保存并重新登录，短 MCP Token `y` 可保存且 `adminRequiresLogin=false`，`/api/admin/logs` 返回日志记录。
- 风险/待确认：Search-2api 仍依赖 search.sh 临时 Cookie 与匹配 User-Agent；仓库和 HF Space 代码不提交任何 Cookie/Key/Token。Tavily 官方 REST `TAVILY_API_KEY` 仍未配置，因为用户提供的是 `tavily_hikari` MCP bearer，不应误填到 Tavily REST API。当前 HF Space 已通过删除重建避开旧 abuse flag，后续如平台再次误判，需要继续避免进程名或命令行出现 `searxng`。

## 任务

- [x] ~~**目标:** 放宽 Admin UI 安全设置保存流程，允许已登录会话直接修改 Admin/MCP Token~~ (创建于: 2026-05-17 14:29:53 | **完成于: 2026-05-17 14:32:34**)
- [x] ~~**目标:** 修复 Admin 密钥修改异常、放宽 Token 长度限制并新增 Admin UI 日志查看~~ (创建于: 2026-05-17 12:46:18 | **完成于: 2026-05-17 12:58:01**)
- [x] ~~**目标:** 删除并重建 Hugging Face Space `Echocq/fusionsearch-mcp`，恢复代码、Secrets 与线上运行~~ (创建于: 2026-05-16 18:22:42 | **完成于: 2026-05-16 18:44:53**)
- [x] ~~**目标:** 复核并补写 Hugging Face Space Secrets 中用户明确提供的临时密钥~~ (创建于: 2026-05-16 17:18:40 | **完成于: 2026-05-16 17:20:19**)
- [x] ~~**目标:** 将用户临时密钥写入 Hugging Face Space Secrets 并核查线上状态~~ (创建于: 2026-05-16 16:50:19 | **完成于: 2026-05-16 17:15:33**)
- [x] ~~**目标:** 等待 Hugging Face 解除 abusive flag 或迁移新 Space 后恢复 FusionSearch 线上运行~~ (创建于: 2026-05-16 17:15:33 | **完成于: 2026-05-16 18:44:53**)
- [x] ~~**目标:** 将官方 LibreSearch 镜像接入 FusionSearch 并作为长期运行依赖~~ (创建于: 2026-05-16 13:25:48 | **完成于: 2026-05-16 14:07:06**)
- [x] ~~**目标:** 修正 Hugging Face Secrets 鉴权优先级并临时重置 Admin Token~~ (创建于: 2026-05-16 13:02:14 | **完成于: 2026-05-16 13:05:49**)
- [x] ~~**目标:** 在 FusionSearch Admin UI 中新增 Hugging Face Secrets 快捷管理能力~~ (创建于: 2026-05-15 19:52:06 | **完成于: 2026-05-15 20:04:18**)
- [x] ~~**目标:** 落实精品工具暴露、Docker Compose 多合一、Hugging Face All-in-one 与 README 更新~~ (创建于: 2026-05-15 15:19:32 | **完成于: 2026-05-15 16:33:55**)
- [x] ~~**目标:** 获取 Hugging Face 写入凭据并同步 Space all-in-one 构建~~ (创建于: 2026-05-15 16:42:34 | **完成于: 2026-05-15 18:25:57**)
- [ ] **目标:** 制定远程 MCP、GrokSearch 架构借鉴与提示词注入 UI 升级方案 (创建于: 2026-05-15 15:00:47)
- [ ] **目标:** 制定 FusionSearch Space 内聚合 LibreSearch、Search-2api 与 Grok/Tavily 的路线 B 架构方案 (创建于: 2026-05-15 14:31:55)
- [x] ~~**目标:** 按 Search-2api README 的 Docker/CMD 验证法测试本地流式输出~~ (创建于: 2026-05-15 12:58:12 | **完成于: 2026-05-15 13:11:21**)
- [x] ~~**目标:** 使用用户提供的新 search.sh Cookie 验证 Search-2api 联通与输出~~ (创建于: 2026-05-15 12:43:35 | **完成于: 2026-05-15 12:49:47**)
- [x] ~~**目标:** 按 Search-2api 文档独立单测 Chat Completions 是否能输出内容~~ (创建于: 2026-05-15 11:28:36 | **完成于: 2026-05-15 11:48:21**)
- [x] ~~**目标:** 核对 Hugging Face / GitHub 的 Search-2api 融合状态，并实测 Search-2api 运行情况~~ (创建于: 2026-05-15 11:05:20 | **完成于: 2026-05-15 11:22:37**)
- [x] ~~**目标:** 维护 FusionSearch 鉴权 UI，并融合/核查 lza6/Search-2api~~ (创建于: 2026-05-15 10:33:39 | **完成于: 2026-05-15 10:50:57**)
- [x] ~~**目标:** 将 FusionSearch MCP 推送部署到 Hugging Face public Docker Space~~ (创建于: 2026-05-15 01:47:32 | **完成于: 2026-05-15 02:12:18**)
- [x] ~~**目标:** 最终复核、提交并推送 FusionSearch MCP 双 worker 产物~~ (创建于: 2026-05-15 01:42:26 | **完成于: 2026-05-15 01:44:49**)
- [x] ~~**目标:** 并行实现双部署 README、二级管理 UI、Admin 鉴权与多 MCP 入口~~ (创建于: 2026-05-15 01:10:08 | **完成于: 2026-05-15 01:36:55**)
- [x] ~~**目标:** 制定 FusionSearch Hugging Face 聚合运行与 UI 鉴权计划书并推送 GitHub~~ (创建于: 2026-05-15 00:54:35 | **完成于: 2026-05-15 00:59:23**)
- [x] ~~**目标:** 制定 sousuo 迁移到 Hugging Face LibreSearch 接口的计划书~~ (创建于: 2026-05-13 20:32:28 | **完成于: 2026-05-13 20:33:45**)
- [x] ~~**目标:** 执行 sousuo 搜索接口迁移并完成本地验证~~ (创建于: 2026-05-13 20:43:33 | **完成于: 2026-05-13 20:49:56**)
- [x] ~~**目标:** 实现 Octopus 风格配置 UI 并完成本地验证~~ (创建于: 2026-05-13 23:00:38 | **完成于: 2026-05-13 23:22:20**)
- [x] ~~**目标:** 为 sousuo MCP 工具服务补齐 Docker Compose 部署文件与说明~~ (创建于: 2026-05-13 23:48:11 | **完成于: 2026-05-13 23:51:20**)
- [x] ~~**目标:** 调研 GuDaStudio/GrokSearch grok-with-tavily 分支并制定融合方案~~ (创建于: 2026-05-14 13:01:34 | **完成于: 2026-05-14 13:01:34**)
- [x] ~~**目标:** 将项目命名为 FusionSearch MCP 并融合 Grok/Tavily/Firecrawl 工具与配置 UI~~ (创建于: 2026-05-14 16:09:03 | **完成于: 2026-05-14 16:40:28**)
- [x] ~~**目标:** 发布 FusionSearch MCP Docker 镜像到 GHCR~~ (创建于: 2026-05-14 16:50:11 | **完成于: 2026-05-14 16:56:17**)
- [x] ~~**目标:** 优化 FusionSearch 管理页 logo 与布局审美并推送更新~~ (创建于: 2026-05-14 17:12:49 | **完成于: 2026-05-14 17:41:41**)
- [x] ~~**目标:** 拆分 Firecrawl 配置区、补充 GuDa 说明并给侧栏增加文字标签~~ (创建于: 2026-05-14 17:48:27 | **完成于: 2026-05-14 18:03:12**)
- [x] ~~**目标:** 制定 FusionSearch 透传与错误代码标准化计划~~ (创建于: 2026-05-14 18:27:44 | **完成于: 2026-05-14 19:30:27**)
- [x] ~~**目标:** 将管理页重做为左侧栏目单页切换并贴近 Octopus 设置页风格~~ (创建于: 2026-05-14 19:30:27 | **完成于: 2026-05-14 20:13:22**)
- [x] ~~**目标:** 纠偏管理页视觉风格，恢复 Octopus 温灰背景、圆润卡片与优雅边框~~ (创建于: 2026-05-14 20:19:21 | **完成于: 2026-05-14 20:38:39**)
