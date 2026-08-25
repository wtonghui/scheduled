#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────
# scheduled 生产部署（Docker 单镜像 + 容器内 PM2 双进程，连已有 MySQL）
#
# 用法：
#   ./scripts/deploy.sh                  # 构建并部署（首次/升级）
#   ./scripts/deploy.sh --no-build       # 仅用现有镜像起/restart
#   ./scripts/deploy.sh --dry-run        # 只校验预检，不构建不部署
#
# 前置：.env.production 已存在并填好（cp .env.production.example .env.production）
# 幂等：entrypoint 会自动 prisma migrate deploy；已有容器直接重启生效。
# ─────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."
COMPOSE="docker compose -f docker-compose.prod.yml"
ENV_FILE="${DEPLOY_ENV_FILE:-.env.production}"
PORT="${DEPLOY_PORT:-8080}"
SKIP_BUILD=0
DRY_RUN=0

for a in "$@"; do
  case "$a" in
    --no-build) SKIP_BUILD=1 ;;
    --dry-run) DRY_RUN=1 ;;
    --env=*) ENV_FILE="${a#--env=}" ;;
    --port=*) PORT="${a#--port=}" ;;
    *) echo "未知参数: $a"; exit 2 ;;
  esac
done

echo "== [预检] $(date '+%F %T')"
[ -f "$ENV_FILE" ] || { echo "✗ 缺少 $ENV_FILE（先 cp .env.production.example $ENV_FILE 并填写）"; exit 1; }
grep -q '^DATABASE_URL=' "$ENV_FILE" || { echo "✗ $ENV_FILE 缺 DATABASE_URL"; exit 1; }
grep -q 'timezone=Z' "$ENV_FILE" || echo "⚠ $ENV_FILE 的 DATABASE_URL 未带 timezone=Z（调度可能 8h 错配，建议加上）"
grep -qE '^PAYLOAD_ENCRYPTION_KEY=0{64}' "$ENV_FILE" && echo "⚠ PAYLOAD_ENCRYPTION_KEY 仍是占位 0…（生产请替换为随机 64 hex）"
if [ "$DRY_RUN" -eq 1 ]; then echo "（--dry-run 结束）"; exit 0; fi

if [ "$SKIP_BUILD" -eq 0 ]; then
  echo "== [1/4] 构建镜像（registry 走项目 .npmrc） =="
  docker build -t scheduled:latest .
fi

echo "== [2/4] 启动/更新容器 =="
$COMPOSE up -d --build

echo "== [3/4] 等待 healthy（含 migrate + 双进程启动，最长 5 分钟） =="
cid=""
st="starting"
for i in $(seq 1 60); do
  cid="$($COMPOSE ps -q scheduled 2>/dev/null | head -1)"
  if [ -z "$cid" ]; then sleep 5; continue; fi
  st="$(docker inspect --format='{{.State.Health.Status}}' "$cid" 2>/dev/null || echo starting)"
  case "$st" in
    healthy) break ;;
    unhealthy)
      echo "✗ 容器 unhealthy，最近日志："
      $COMPOSE logs --tail=40 || true
      exit 1
      ;;
  esac
  sleep 5
done

if [ "$st" != "healthy" ]; then
  echo "✗ 超时未 healthy，最近日志："
  $COMPOSE logs --tail=60 || true
  exit 1
fi

echo "== [4/4] 验证 =="
curl -sf -o /dev/null "http://localhost:${PORT}/api/v1/healthz" && echo "✓ healthz 200" || echo "✗ healthz 不可达"
code="$(curl -s -o /dev/null -w '%{http_code}' "http://localhost:${PORT}/api/v1/readyz" || true)"
if [ "$code" = "200" ]; then
  echo "✓ readyz 200（DB+邮件就绪）"
else
  echo "⚠ readyz $code（DB/SMTP 有未就绪项；看响应详情诊断）"
  curl -s "http://localhost:${PORT}/api/v1/readyz" | head -c 300 || true
  echo
fi

echo "== 部署完成 =="
echo "访问: http://localhost:${PORT}/tasks"
echo "进程: $COMPOSE exec scheduled node_modules/.bin/pm2 list"