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

COPY src ./src
COPY public ./public
COPY services ./services
COPY deploy ./deploy

RUN mkdir -p /app/config /app/logs \
    && chmod +x /app/deploy/hf-allinone/start.sh

EXPOSE 1666

ENTRYPOINT []
CMD ["sh", "/app/deploy/hf-allinone/start.sh"]
