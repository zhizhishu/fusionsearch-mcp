FROM node:20-bookworm-slim AS node-runtime

FROM libregroup/libresearch:latest

WORKDIR /app

ENV NODE_ENV=production
ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1
ENV PATH=/usr/local/bin:$PATH
ENV GRANIAN_PROCESS_NAME=fusionsearch-libre

COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /usr/local/bin/npm /usr/local/bin/npm
COPY --from=node-runtime /usr/local/bin/npx /usr/local/bin/npx
COPY --from=node-runtime /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -sf ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -sf ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

COPY package*.json ./
RUN npm ci --omit=dev

COPY services/search2api/requirements.txt ./services/search2api/requirements.txt
RUN python3 -m venv /opt/search2api-venv \
    && /opt/search2api-venv/bin/pip install --no-cache-dir -r /app/services/search2api/requirements.txt

# perplexity(第6源)独立 venv：curl_cffi 有 manylinux wheel、无需浏览器/编译器。
# venv 自检(import 关键依赖)：装不上就让 build 当场失败、暴露问题，别拖到运行时 status=127。
COPY services/perplexity/requirements.txt ./services/perplexity/requirements.txt
# --copies：把 python 可执行真复制进 venv，不做 symlink——base 镜像(SearXNG 自带 venv)的
# python3 若被 symlink 会在最终镜像里断链导致运行时 "bin/python: not found"(status 127)。
RUN python3 -m venv --copies /opt/pplx-venv \
    && ls -la /opt/pplx-venv/bin/ \
    && /opt/pplx-venv/bin/python --version \
    && /opt/pplx-venv/bin/pip install --no-cache-dir -r /app/services/perplexity/requirements.txt \
    && /opt/pplx-venv/bin/python -c "import curl_cffi, fastmcp, aiohttp, aiohttp_socks, websocket; print('[build] perplexity venv self-check OK')"

# perplexity session 保活用 Playwright(无头 chromium)：定期带 cookie 真访问 perplexity.ai 保活 + 抓 rotation 新 cookie，
# 走 HighPurity 干净出口(http 正向代理,chromium 支持 http-proxy 认证)。chromium+依赖较大(~400MB)、仅保活用。
# --with-deps 自动 apt 装 chromium 系统依赖；装不上让 build 当场失败、别拖到运行时。
RUN /opt/pplx-venv/bin/pip install --no-cache-dir playwright \
    && /opt/pplx-venv/bin/playwright install --with-deps chromium \
    && /opt/pplx-venv/bin/python -c "from playwright.sync_api import sync_playwright; print('[build] playwright chromium self-check OK')"

COPY src ./src
COPY public ./public
COPY services ./services
COPY deploy ./deploy

RUN mkdir -p /app/config /app/logs \
    && chmod +x /app/deploy/hf-allinone/start.sh

EXPOSE 1666

ENTRYPOINT []
CMD ["sh", "/app/deploy/hf-allinone/start.sh"]
