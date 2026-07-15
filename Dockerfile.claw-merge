# ============================================================================
# FusionSearch + ClawEmail 合并 all-in-one 镜像（目标：部署到 alphaeee/claw Space）
# ----------------------------------------------------------------------------
# Build context 假设（自包含形态，便于云端验证）：以 fusion 源为集成层主体，
# clawemail 全部源码放在子目录 mail/：
#   <context>/  package.json src/ public/ services/ deploy/ Dockerfile.claw-merge  (fusion)
#   <context>/mail/  package.json src/ ...                                         (clawemail 全部源码)
# ⚠️ context 需带一个 .dockerignore 排除 **/node_modules（尤其 mail/node_modules），
#    否则 COPY mail/ 会把 clawemail 本地 node_modules 覆盖掉 builder 里刚编好的。
# 最终形态（build 时 git clone 两源 pin commit vs 自包含快照）由用户拍板；本文件用
# 自包含，云端验证与最终形态无关（build 逻辑一致，只是源码来源不同）。
#
# 关键决策：统一 node 22 —— fusion 纯 JS(express/mcp-sdk/cors/zod)升 22 零 ABI 风险；
# clawemail better-sqlite3 用 node22 编、运行时也 node22，原生模块 ABI 匹配不崩。
# base = libregroup/libresearch:latest（已坐实=SearXNG 的 Void Linux glibc 版，
# 能跑 glibc node 二进制 + libstdc++，故 debian bookworm 编的原生 .node 可直接跑）。
# ============================================================================

# ---- node 22 runtime 二进制来源（glibc/bookworm） ----
FROM node:22-bookworm-slim AS node-runtime

# ---- clawemail builder：编 better-sqlite3(node22 ABI) + vite build(base=/email) ----
FROM node:22-bookworm-slim AS claw-builder
WORKDIR /claw
# better-sqlite3 原生模块编译依赖（与 clawemail 原 Dockerfile 一致，已验证可行）
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
COPY mail/package*.json ./
RUN npm ci
COPY mail/ ./
# VITE_API_BASE=/email：vite base 让静态资源引用带 /email 前缀，同时前端 API/SSE/附件
# 全走 /email（api.ts 的 API_BASE 读同一个 VITE_API_BASE）。esbuild 后端 bundle 一并产出。
RUN VITE_API_BASE=/email npm run build
# 只留生产依赖（含已编译好的 better-sqlite3 原生模块）
RUN npm prune --omit=dev

# ---- 最终 all-in-one：libregroup/libresearch (Void Linux glibc) ----
FROM libregroup/libresearch:latest

WORKDIR /app

ENV NODE_ENV=production
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH=/usr/local/bin:$PATH
ENV GRANIAN_PROCESS_NAME=fusionsearch-libre

# node 22 二进制 + 全局 npm/npx
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# fusion node 依赖
COPY package*.json ./
RUN npm ci --omit=dev

# search2api venv
COPY services/search2api/requirements.txt ./services/search2api/requirements.txt
RUN python3 -m venv /opt/search2api-venv \
    && /opt/search2api-venv/bin/pip install --no-cache-dir -r /app/services/search2api/requirements.txt

# perplexity venv（curl_cffi manylinux wheel，无需浏览器/编译器；--copies 防 symlink 断链）
COPY services/perplexity/requirements.txt ./services/perplexity/requirements.txt
RUN python3 -m venv --copies /opt/pplx-venv \
    && /opt/pplx-venv/bin/pip install --no-cache-dir -r /app/services/perplexity/requirements.txt \
    && /opt/pplx-venv/bin/python -c "import curl_cffi, fastmcp, aiohttp, aiohttp_socks, websocket; print('[build] perplexity venv self-check OK')"

# fusion 源码
COPY src ./src
COPY public ./public
COPY services ./services
COPY deploy ./deploy

# clawemail 构建产物（dist + 生产 node_modules 含 better-sqlite3 原生模块）→ /app/mail
COPY --from=claw-builder /claw/dist /app/mail/dist
COPY --from=claw-builder /claw/node_modules /app/mail/node_modules
COPY --from=claw-builder /claw/package*.json /app/mail/

RUN mkdir -p /app/config /app/logs /app/mail/data \
    && chmod +x /app/deploy/hf-allinone/start.sh

# 对外端口 = clawemail Space 原 app_port 3000（fusion node 监听；HF 会注入 PORT=3000）。
# 容器内：fusion node :3000(对外) / clawemail :3100(内部,MOUNT_MAIL=on 时反代 /email) /
#         SearXNG :8080 / search2api :8000 / perplexity :8001。
EXPOSE 3000

ENTRYPOINT []
CMD ["sh", "/app/deploy/hf-allinone/start.sh"]
