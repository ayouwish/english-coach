# syntax=docker/dockerfile:1
# english-coach web（Next.js standalone）
#
# ⚠️ 构建期必须传 VOICE_SERVICE_URL：rewrites() 在 next build 时求值并写进
#    .next/routes-manifest.json，运行时改环境变量**无效**。
#   docker build --build-arg VOICE_SERVICE_URL=http://voice:8100 -t english-coach-web ../web
#   自检：docker compose exec web grep -o '"destination":"[^"]*"' .next/routes-manifest.json

FROM node:22-bookworm-slim AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# CLI --store-dir 覆盖 pnpm-workspace.yaml 里的宿主路径，容器内用独立 store
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

FROM node:22-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN corepack enable
# ★ 必须在 pnpm build 之前生效，否则 /voice/* 会被烘焙成 127.0.0.1
ARG VOICE_SERVICE_URL=http://127.0.0.1:8100
ENV VOICE_SERVICE_URL=$VOICE_SERVICE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不要连数据库：建表/种子放到运行时首次请求（ensureBootstrap）
ENV AUTO_SEED=1
RUN pnpm build

FROM node:22-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1 \
    DATA_DIR=/app/data \
    MIGRATIONS_DIR=/app/migrations
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
# 运行时必须存在：migrations（建表）、src/data（种子语料）、scripts（可选 CLI）
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/src/data ./src/data
COPY --from=builder /app/scripts ./scripts

RUN mkdir -p /app/data/audio && chown -R node:node /app/data
USER node
EXPOSE 3000

# 探活：voice 不可达时 /api/health 仍返回 200，所以这里只判断 web 自身
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
