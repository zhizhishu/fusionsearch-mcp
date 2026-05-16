# FusionSearch Hugging Face 聚合运行计划书

创建时间：2026-05-15 00:54:35

## 目标

把现有 FusionSearch MCP 从“服务器 Docker Compose + 外部 LibreSearch Space”的形态，升级为“可直接在 Hugging Face Docker Space 上运行”的一体化形态。最终效果是：

- 一个 Hugging Face Space 对外提供 `/admin`、`/mcp`、`/sse`、`/api/search/stream`。
- LibreSearch/SearXNG 也聚合进同一个运行体，默认搜索端点走容器内部地址。
- 继续保留服务器 Docker Compose 和 GHCR 镜像部署能力。
- Public Space 下 `/admin` 和配置 API 必须有鉴权，API Key 不回显、不写死、不进仓库。

## 官方约束

本计划按 Hugging Face 当前官方文档设计：

- Docker Space 通过 Space `README.md` 顶部 YAML 设置 `sdk: docker`，并用 `app_port` 指定外部暴露端口。参考：https://huggingface.co/docs/hub/main/en/spaces-sdks-docker
- Docker Space 内部可以开多个端口；如果要对外暴露多服务，需要用 Nginx 之类的反向代理把外部单端口分发到内部端口。参考同上。
- Space 的 Variables/Secrets 应在 Space Settings 配置，不要硬编码密钥；Docker Space 运行时可从环境变量读取。参考：https://huggingface.co/docs/hub/spaces-overview
- 免费 Space 会睡眠，暂停后需要重启；磁盘默认不持久，持久化配置需要 `/data` 或外部存储。参考：https://huggingface.co/docs/hub/spaces-overview
- Hugging Face OAuth 可通过 `hf_oauth: true` 开启，适合后续做“Sign in with HF”。参考：https://huggingface.co/docs/hub/main/spaces-oauth

## 推荐路线

采用两阶段方案，先把 FusionSearch 自身变成 Hugging Face 可运行，再把 LibreSearch 嵌入同容器。这样风险最低，也不会一次性把 Dockerfile 搞得太重。

### 阶段 1：FusionSearch 先跑进 Hugging Face Space

改动范围：

- 在仓库补齐 Hugging Face Space 元数据方案。
- 让服务监听 Hugging Face `app_port`，默认仍兼容服务器 `PORT=1666`。
- 增加 Hugging Face 部署文档：创建 Space、设置 public、设置 Secrets、推送仓库。
- `SEARCH_ENDPOINT` 暂时仍可指向现有 `https://echocq-libresearch.hf.space/search`。
- `/admin` 增加鉴权，避免 public Space 里任何人都能改配置。

验收：

- Space App 页面能打开 `/admin` 登录页。
- `/health` 可公开访问。
- 未登录访问 `/api/admin/config` 返回 `401`。
- 登录后可读取脱敏配置、测试搜索、保存运行配置。
- Cherry Studio 能访问 Space URL 的 `/mcp` 或 `/sse`。

### 阶段 2：LibreSearch/SearXNG 聚合进同一个 Space

推荐架构：

```text
Hugging Face 外部端口 7860
        |
      Nginx
        |
        +-- /admin, /api, /mcp, /sse, /messages -> Node FusionSearch :1666
        |
        +-- /search, /libresearch/* -> LibreSearch/SearXNG :8080
```

实现要点：

- 新增一体化 Dockerfile，或把现有 Dockerfile 升级为多进程容器。
- 用 `supervisord` 或等价轻量启动器管理 `nginx`、`node`、`libresearch` 三个进程。
- 默认 `SEARCH_ENDPOINT=http://127.0.0.1:8080/search`，也保留环境变量覆盖。
- LibreSearch 必须确认 `format=json` 可用，SearXNG 配置里开启 JSON 输出。
- 对外只暴露 Nginx 一个端口，内部服务不直接暴露。

待确认点：

- `libregroup/libresearch` 镜像是否适合作为基础镜像安装 Node。
- 如果不适合，改用 Node/Debian 基础镜像安装 SearXNG/LibreSearch。
- 镜像体积和冷启动时间是否可接受。免费 Space 会睡眠，镜像越重，冷启动越慢。

### 阶段 3：保留服务器与 GHCR 部署

不能只为了 Hugging Face 把原服务器部署打坏。保留策略：

- `docker-compose.yml` 继续提供服务器部署入口。
- GHCR `latest` 继续构建。
- 如果一体化镜像过重，可拆出 build target：
  - `fusionsearch-mcp:latest`：只跑 Node MCP 层。
  - `fusionsearch-mcp:hf`：跑 Node + LibreSearch + Nginx。
- README 中明确两种部署方式的区别。

## 鉴权方案

### 第一版：Admin Token，先稳住 public Space

新增环境变量：

- `ADMIN_AUTH_ENABLED=true`：开启管理页鉴权。
- `ADMIN_TOKEN`：Hugging Face Secret，作为管理页登录口令。
- `SESSION_SECRET`：Hugging Face Secret，用于签名 session cookie。
- `MCP_AUTH_TOKEN`：可选，保护 `/mcp`、`/sse`、`/messages` 等 MCP 入口。

后端改动：

- 新增 `auth.js` 或同等模块，职责单一：
  - 校验 `ADMIN_TOKEN`。
  - 签发 httpOnly、SameSite=Lax、Secure 的 session cookie。
  - 给 `/api/admin/*`、配置保存、测试接口加鉴权中间件。
  - `GET /health`、静态资源、登录页保持公开。
- 所有配置响应继续脱敏，绝不返回 API Key 明文。
- 错误返回统一结构：`{ error: { code, message } }`。

前端改动：

- `/admin` 打开后先请求 `/api/admin/session`。
- 未登录显示 Octopus 风格登录卡片，不进入配置表单。
- 登录成功后再加载配置。
- 提供退出登录按钮。
- 保存和测试接口遇到 `401` 时回到登录态。

验收测试：

- 无 cookie 访问 `GET /api/admin/config` 为 `401`。
- 错误 `ADMIN_TOKEN` 登录为 `401`。
- 正确 `ADMIN_TOKEN` 登录后能读取配置。
- `PUT /api/admin/config` 必须登录。
- 页面源码、接口响应、日志都不出现 API Key 明文。
- `ADMIN_AUTH_ENABLED=false` 时，本地开发可不登录。

### 第二版：Hugging Face OAuth，做更优雅的身份验证

在第一版稳定后再做 OAuth，不抢第一阶段进度。

新增 Space metadata：

```yaml
hf_oauth: true
hf_oauth_expiration_minutes: 480
```

后端新增：

- `/auth/login`：跳转 Hugging Face OAuth。
- `/auth/callback`：校验 state，交换 token，读取 userinfo。
- `HF_AUTHORIZED_USERS`：允许的 Hugging Face 用户名白名单。
- `HF_AUTHORIZED_ORGS`：可选组织白名单。

建议：

- Public Space 下先用 `ADMIN_TOKEN`，实现简单、可靠、不会卡在 OAuth 回调和 iframe cookie 细节。
- OAuth 作为增强项，后续再做。

## 配置持久化策略

服务器 Docker Compose：

- 继续使用 `config/runtime.json` 持久化。

Hugging Face Space：

- API Key 类配置优先走 Space Secrets。
- 非敏感默认值可走 Space Variables。
- 如果没有持久存储，`/admin` 保存的 runtime 配置只保证当前容器生命周期有效，UI 必须显示“当前为 Hugging Face 临时运行配置”。
- 如果绑定 `/data`，设置 `RUNTIME_CONFIG_PATH=/data/runtime.json`，配置可跨重启保存。

## 需要改的文件

预计修改：

- `README.md`：补 Hugging Face Space 部署说明，必要时增加 Space YAML front matter。
- `Dockerfile`：支持 Hugging Face 端口，后续升级为一体化运行。
- `src/server.js`：支持 Space 端口和鉴权相关配置。
- `src/app.js`：给 `/api/admin/*`、`/mcp`、`/sse` 等入口接入中间件。
- `src/runtimeConfig.js`：识别 Hugging Face ephemeral/persistent 配置路径。
- `public/admin/index.html`、`public/admin/app.js`、`public/admin/style.css`：增加登录态 UI，保持 Octopus 风格。
- 新增 `src/auth.js`：集中鉴权逻辑，避免散在路由里。
- 新增 `hf/` 或 `deploy/huggingface/`：如需要 Nginx、supervisord、LibreSearch 配置。

## 迭代清单

1. 计划落地并推送 GitHub。
2. 实现 Admin Token 鉴权，保护 `/admin` 与配置 API。
3. 补 Hugging Face Space 运行配置，先让 FusionSearch 自身在 Space 跑起来。
4. 验证 public Space 下的登录、配置读取、MCP 入口和冷启动提示。
5. 调研并嵌入 LibreSearch/SearXNG 到同容器。
6. 用 Nginx 统一外部端口，内部路由到 Node 与 LibreSearch。
7. 更新 README、服务器 Compose 文档和 GHCR 构建说明。

## 风险与处理

- 风险：一体化镜像变大，免费 Space 冷启动更慢。
  - 处理：先分阶段上线，再评估是否需要分 `latest` 和 `hf` 镜像。
- 风险：Hugging Face 默认磁盘不持久，UI 保存配置重启后丢失。
  - 处理：Secrets 做主配置，`/data` 做可选持久化，UI 明确提示当前存储状态。
- 风险：public Space 暴露管理面板。
  - 处理：先做 `ADMIN_TOKEN`，再考虑 HF OAuth。
- 风险：LibreSearch/SearXNG JSON 未启用。
  - 处理：构建内置配置时固定开启 `format=json`，测试 `/search?q=test&format=json`。

## 设计原则

- KISS：第一版只做 Token 鉴权和 FusionSearch Space 化，不把 OAuth、内置 LibreSearch、持久存储一次性混在一起。
- YAGNI：不先做账号系统和数据库，等真实需要多用户再扩展。
- DRY：鉴权中间件集中实现，所有 admin API 复用。
- SOLID：鉴权、运行配置、搜索客户端、融合客户端继续拆分，避免 `app.js` 继续膨胀。
