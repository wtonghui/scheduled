# ─────────────────────────────────────────────────────────────
# scheduled 生产镜像：单镜像，容器内 PM2 守护 web + worker 双进程
# 多阶段构建；runtime 只装 production 依赖（pm2/prisma/tsx 在 dependencies）
# ─────────────────────────────────────────────────────────────

FROM node:22-alpine AS base
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ---------- deps：全量依赖（供 build 阶段） ----------
FROM base AS deps
# .npmrc 统一提供 registry（镜像源在项目级 .npmrc 配置，勿在 Dockerfile 硬编码）
COPY package.json package-lock.json .npmrc ./
RUN npm ci

# ---------- build：prisma client + next build ----------
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 构建期仅需 env 通过 zod 校验（fail-fast 只查存在性/格式，不连库）；运行时由 env_file 覆盖
ENV DATABASE_URL="mysql://build:build@127.0.0.1:3306/scheduled?connectionLimit=25&timezone=Z" \
    APP_BOOTSTRAP_TOKEN="0000000000000000" \
    PAYLOAD_ENCRYPTION_KEY="0000000000000000000000000000000000000000000000000000000000000000"
RUN npx prisma generate && npm run build

# ---------- runtime：生产运行 ----------
FROM base AS runtime
ENV NODE_ENV=production
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev && npm cache clean --force
# 生成好的 Prisma Client（避免运行时再 generate）
COPY --from=build /app/node_modules/.prisma ./node_modules/.prisma
# 产物与源码（worker 直接跑 ts 源码）
COPY --from=build /app/.next ./.next
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/src ./src
COPY --from=build /app/worker ./worker
COPY --from=build /app/scripts ./scripts
COPY ecosystem.config.cjs ./
# 根配置文件：prisma.config（migrate 读 DB URL）、tsconfig（tsx 解析 @/ 别名）、next.config
COPY --from=build /app/prisma.config.ts ./
COPY --from=build /app/tsconfig.json ./
COPY --from=build /app/next.config.ts ./
COPY docker-entrypoint.sh ./
RUN chmod +x docker-entrypoint.sh

EXPOSE 3000
ENTRYPOINT ["./docker-entrypoint.sh"]
