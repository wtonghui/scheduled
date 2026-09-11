#!/bin/sh
set -e

# 生产容器入口：
# 1) 数据库迁移：默认走纯 JS 驱动（mysql2），绕过 Prisma Rust schema engine
#    以兼容 OceanBase（Rust engine 启动时查 @@socket，OB 不支持 → CrashLoop）。
#    设 USE_PRISMA_MIGRATE=true 可回退为 npx prisma migrate deploy（真 MySQL 环境）。
# 2) seed（幂等）：表空时创建 default 租户 + bootstrap token，已有则跳过。
# 3) 前台启动 PM2（PID1）拉起 web + worker 双进程。
if [ "$USE_PRISMA_MIGRATE" = "true" ]; then
  echo "[entrypoint] applying database migrations (prisma migrate deploy)..."
  npx prisma migrate deploy
else
  echo "[entrypoint] applying database migrations (JS driver, OceanBase-safe)..."
  node scripts/migrate-deploy.mjs
fi

echo "[entrypoint] seeding (ensureBootstrap, idempotent)..."
npx tsx prisma/seed.ts

echo "[entrypoint] starting pm2 (web + worker)..."
exec node node_modules/pm2/bin/pm2-runtime ecosystem.config.cjs