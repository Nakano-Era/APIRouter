# syntax=docker/dockerfile:1
FROM docker:cli AS docker-client

FROM node:24-bookworm-slim AS dependencies
WORKDIR /opt/apirouter
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

FROM node:24-bookworm-slim AS broker
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=docker-client /usr/local/bin/docker /usr/local/bin/docker
WORKDIR /opt/apirouter
COPY --from=dependencies /opt/apirouter/node_modules ./node_modules
COPY server/net.mjs ./server/net.mjs
COPY runner ./runner
ENV NODE_ENV=production
EXPOSE 3210
CMD ["node", "runner/broker.mjs"]

FROM node:24-bookworm-slim AS worker
ARG CLAUDE_CODE_VERSION=2.1.285
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates python3 python3-venv python3-pil python3-docx python3-openpyxl python3-reportlab git ripgrep bash && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv --system-site-packages /opt/pythonenv \
    && /opt/pythonenv/bin/pip install --no-cache-dir python-pptx==1.0.2 XlsxWriter==3.2.9 typing-extensions==4.15.0 \
    && npm install --global --no-audit --no-fund @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION} && npm cache clean --force \
    && claude --version
WORKDIR /opt/apirouter
COPY --chown=node:node runner/worker.mjs runner/protocol.mjs ./
RUN mkdir -p /workspace && chown node:node /workspace
ENV NODE_ENV=production PATH=/opt/pythonenv/bin:$PATH
USER node
WORKDIR /workspace
CMD ["node", "/opt/apirouter/worker.mjs"]
