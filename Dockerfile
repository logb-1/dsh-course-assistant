# 课程助手 web 版：Python 外壳 + 仓库里的 Node 流水线
# 构建上下文必须是仓库根目录（core/、bin/、package.json、server/ 都在这里）

FROM node:22-bookworm-slim AS nodedeps
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    NODE_BIN=/usr/local/bin/node \
    DATA_DIR=/data

# Node 运行时（流水线是 ESM，只需要 node 本体）
COPY --from=nodedeps /usr/local/bin/node /usr/local/bin/node

WORKDIR /app
COPY server/requirements.txt server/requirements.txt
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates libstdc++6 \
    && rm -rf /var/lib/apt/lists/* \
    && pip install -r server/requirements.txt

COPY package.json ./
COPY core ./core
COPY bin ./bin
COPY server ./server
COPY --from=nodedeps /app/node_modules ./node_modules

RUN mkdir -p /data && node --version

EXPOSE 8000

CMD ["sh", "-c", "uvicorn app.main:app --app-dir server --host 0.0.0.0 --port ${PORT:-8000}"]
