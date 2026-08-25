#!/bin/sh
set -e

# 生产容器入口：
# 1) 幂等应用数据库迁移（首次部署/每次镜像更新时自动执行）
# 2) 以前台方式启动 PM2（PID1）拉起 web + worker 双进程

echo "[entrypoint] applying database migrations (prisma migrate deploy)..."
npx prisma migrate deploy

echo "[entrypoint] starting pm2 (web + worker)..."
exec node node_modules/pm2/bin/pm2-runtime ecosystem.config.cjs