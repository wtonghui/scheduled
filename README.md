# Scheduled — 定时任务管理器

调度即服务：运维/外部用户通过 REST API 或 Web 控制台定义定时任务（cron 或固定间隔），到点时平台向调用方 URL 发起 HTTP 请求，任务终态发送邮件 + Webhook 回调。生产级：多租户隔离、恰好一次领取、幂等通知、SSRF 防护、敏感负载加密、可观测。

## 架构

- **Web**（Next.js 16 App Router，`src/app`）：REST API `/api/v1/*` + 控制台 Web UI。
- **Worker**（`worker/`，独立长驻进程）：轮询 MySQL 领取到期任务（`SELECT ... FOR UPDATE SKIP LOCKED` + 租约），有界异步并发（p-limit）执行，邮件/Webhook outbox 中继。
- **DB**：MySQL 8，Prisma 7（driver adapter `@prisma/adapter-mariadb`）。表：`task` / `task_execution` / `email_log` / `webhook_delivery` / `api_token` / `tenant` / `worker_lease`。

分层：API → service → repository → ORM；执行器按 `taskType` 注册（http/noop）；邮件挂 `MailService` 端口后。

## 快速开始（详见 `specs/001-scheduled-tasks/quickstart.md`）

```bash
# 1. 依赖 + 迁移 + 种子（首个租户/管理 token/noop 冒烟任务）
npm install
npx prisma migrate dev --name init
npm run seed

# 2. 把 .env.example 复制为 .env 并填写
#    DATABASE_URL / APP_BOOTSTRAP_TOKEN / PAYLOAD_ENCRYPTION_KEY(32字节hex) / TOKEN_PREFIX

# 3. 两进程
npm run dev:web       # http://localhost:3000
npm run dev:worker    # 长驻调度/执行/中继

# 4. 签发日常 token（明文仅返回一次）
curl -X POST localhost:3000/api/v1/tokens \
  -H "x-api-token: $APP_BOOTSTRAP_TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"dev","scopes":["tasks:read","tasks:write"]}'

# 5. CRUD
curl -X POST localhost:3000/api/v1/tasks -H "x-api-token: $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"心跳","cron":"*/5 * * * *","taskType":"http","payload":{"url":"https://example.com/health","method":"GET"},"recipients":["ops@example.com"]}'
```

## 测试

```bash
npm run test:unit        # libs / tokens / envelope（vitest）
npm run test:integration # CRUD、领取幂等、重试/超时、outbox、邮件/Webhook 中继
npm run test:e2e         # Playwright 冒烟（需 web + worker 运行）
npm run coverage         # 覆盖率门禁
```

## 主要端点（`/api/v1`）

| 端点 | 说明 |
|---|---|
| `GET/POST /tasks` | 列表 / 创建（自动归属租户） |
| `GET/PATCH/DELETE /tasks/:id` | 详情 / 更新（乐观并发 `version`→409）/ 删除 |
| `POST /tasks/:id/run-now` | 立即运行 |
| `GET /tasks/:id/executions`、`GET /executions` | 执行历史 |
| `GET /email-log`、`GET /tasks/:id/webhook-deliveries` | 通知记录 |
| `POST/GET /tokens`、`DELETE /tokens/:id`、`GET /tokens/whoami` | token 管理 |
| `GET /healthz`、`GET /readyz`、`GET /metrics` | 探针 / Prometheus 指标 |
| `GET /docs` | OpenAPI 3 文档 |

鉴权：`x-api-token` 头（`sche-`+48 base62；DB 仅存 SHA-256 哈希，`timingSafeEqual` 校验；scope `tasks:read`/`tasks:write`/`tokens:manage`）。

## 安全设计

- 多租户：所有查询强制 `tenant_id`，跨租户 404。
- 敏感负载：`payload_secrets` AES-256-GCM（`PAYLOAD_ENCRYPTION_KEY`），明文不入库/日志。
- SSRF：拒绝 loopback/RFC1918/link-local/元数据 IP；DNS 复核；重定向 ≤3 且逐跳复查（`SSRF_ALLOW_PRIVATE` 仅测试用）。
- 通知幂等：outbox + `run_id` UNIQUE；Webhook 带 `X-Scheduled-Signature: t=<unix>,v1=<hmac>` 验签。

## 运维

- PM2：`pm2 start ecosystem.config.cjs`（web + worker 两进程）。
- 优雅关停：`SIGTERM` 停止领取 → 排空在途（`SHUTDOWN_GRACE_MS`）→ 干净退出。
- 重启不补跑：错过的运行只推进 `next_run_at`，不执行。