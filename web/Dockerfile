# syntax=docker/dockerfile:1
# english-coach web（Next.js standalone）
#
# ⚠️ 构建期必须传 VOICE_SERVICE_URL：rewrites() 在 next build 时求值并写进
#    .next/routes-manifest.json，运行时改环境变量**无效**。
#   docker build --build-arg VOICE_SERVICE_URL=http://voice:8100 -t english-coach-web ../web
#   自检：docker compose exec web grep -o '"destination":"[^"]*"' .next/routes-manifest.json
#
# 国内/离线环境（NAS 常见）请指定镜像源，同时解决"拉不到包"和"构建慢"：
#   --build-arg NPM_REGISTRY=https://registry.npmmirror.com
# compose 里通过 .env 的 NPM_REGISTRY 传入（默认官方源）。

# ─────────────────────────────────────────────────────────────────────────────
# base：统一的 pnpm 安装层
#
# ★ 这里**不用 corepack**。corepack 的机制是"真正运行 pnpm 那一刻才去 registry
#   现下对应版本"，于是多阶段构建里每个用到 pnpm 的 stage 都要联网下载一次。
#   飞牛 NAS 上实测：deps 阶段装依赖成功（314s），但 builder 阶段 `pnpm build`
#   又要从 registry.npmjs.org 下 pnpm-11.28.5.tgz，直接 ECONNRESET 构建失败。
#   改成在基础层用 npm 显式装一次 pnpm 并复用，构建过程可预期得多。
# ─────────────────────────────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# pnpm 版本与 package.json 的 `packageManager` 保持一致（换版本时两边一起改）
ARG PNPM_VERSION=11.28.5
# npm registry（国内可传 https://registry.npmmirror.com）
ARG NPM_REGISTRY=https://registry.npmjs.org

# --force：覆盖 corepack 留下的 shim，确保 `pnpm` 就是刚装好的这个二进制。
# 下一行 `pnpm --version` 会立刻暴露问题（若仍是 corepack shim，它会尝试联网并失败）。
RUN npm config set registry "$NPM_REGISTRY" \
 && npm install -g --force pnpm@${PNPM_VERSION} \
 && pnpm --version

# ─────────────────────────────────────────────────────────────────────────────
# deps：装依赖（含 better-sqlite3 的原生编译工具链）
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS deps
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# CLI --store-dir 覆盖 pnpm-workspace.yaml 里的宿主路径，容器内用独立 store
RUN pnpm install --frozen-lockfile --store-dir /pnpm-store

# ─────────────────────────────────────────────────────────────────────────────
# builder：next build（pnpm 由 base 提供，不再联网下载）
# ─────────────────────────────────────────────────────────────────────────────
FROM base AS builder
# ★ 必须在 pnpm build 之前生效，否则 /voice/* 会被烘焙成 127.0.0.1
ARG VOICE_SERVICE_URL=http://127.0.0.1:8100
ENV VOICE_SERVICE_URL=$VOICE_SERVICE_URL
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期不要连数据库：建表/种子放到运行时首次请求（ensureBootstrap）
ENV AUTO_SEED=1
RUN pnpm build

# ─────────────────────────────────────────────────────────────────────────────
# runner：只带 standalone 产物
# ─────────────────────────────────────────────────────────────────────────────
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

# ★ 把从**构建上下文**拷进来的目录统一成"任何用户可读"。
#   原因：如果宿主机/CI 上的仓库文件是 600（umask 077，或用 scp/rsync 保留了权限），
#   `COPY` 会把 600 原样带进镜像；而运行期是 `USER node`（uid 1000），读不了 root 的 600 文件，
#   表现为：
#     /api/health → status=degraded, db.ok=false
#     db.error = EACCES: permission denied, open '/app/migrations/0001_init.sql'
#     （同理 scripts/ 与 src/data/ 也会 EACCES，预热脚本读不到语料）
#   `a+rX`：文件加读、目录加读+进入，不改变已有可执行位。
RUN chmod -R a+rX /app/migrations /app/src/data /app/scripts /app/public

RUN mkdir -p /app/data/audio && chown -R node:node /app/data
USER node
EXPOSE 3000

# 探活：voice 不可达时 /api/health 仍返回 200，所以这里只判断 web 自身
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
