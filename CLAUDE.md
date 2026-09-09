# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概览

调度即服务（scheduling-as-a-service）：运维/外部用户通过 REST API（`/api/v1/*`）或 Web 控制台定义定时任务（cron 或固定间隔），由**独立 worker 进程**到点领取并执行 HTTP 请求，任务终态发邮件 + Webhook 回调。多租户、恰好一次领取、幂等通知、SSRF 防护、敏感负载加密。

**双进程架构**：
- **Web**（`src/app`，Next.js 16 App Router）：REST API 路由（`src/app/api/v1/**/route.ts`）+ Web 控制台（`src/app/(web)/`）。
- **Worker**（`worker/`，独立 tsx 常驻进程）：轮询领取到期任务 → 有界并发执行 → 邮件/Webhook outbox 中继。**不会随 `next dev` 启动**，需单独运行。

**DB**：MySQL 8 + Prisma 7（driver adapter `@prisma/adapter-mariadb`）。表：`task` / `task_execution` / `email_log` / `webhook_delivery` / `api_token` / `tenant` / `worker_lease`。

完整设计文档在 `specs/001-scheduled-tasks/`（spec.md / data-model.md / contracts/api.md 等）；README.md 有快速开始和端点表。

## 常用命令

```bash
# 本地开发（两个进程都要起）
npm run dev:web          # http://localhost:3000
npm run dev:worker       # 常驻调度/执行/中继（tsx watch）

# 构建 / 生产
npm run build && npm run start:web
npm run start:worker

# 代码质量（biome，非 eslint）
npm run lint             # biome check .
npm run format           # biome format --write .

# 数据库（MySQL 由 docker-compose.yml 提供，映射宿主 13306）
docker compose up -d
npm run prisma:generate
npm run prisma:migrate   # migrate dev
npm run prisma:deploy    # 生产迁移
npm run seed             # 首个租户 + 引导 token（幂等；不插入示例/冒烟任务）

# 测试（见「测试」节）
npm run test:unit        # vitest run tests/unit
npm run test:integration # 需要 docker MySQL 已在 13306 运行
npm run test             # vitest run + tsx 运行时回归
npm run test:runtime     # 仅 tsx 互操作回归（与 worker 同加载器，防 cron-parser 命名导出为空的漏检）
npm run coverage
```

## 环境变量

`.env` 从 `.env.example` 复制。`src/lib/config.ts` 用 zod 在模块加载时 **fail-fast 校验**，缺失/非法立即抛错；改环境变量后重启相关进程。

关键变量：
- `DATABASE_URL` — 开发指向 3306 的本机 MySQL（.env.example 默认）；**集成测试固定用 13306**（见 `tests/setup.ts`）。
- `APP_BOOTSTRAP_TOKEN`（≥16 字符）— 首个管理 token，仅在签发接口换取日常 token 时**明文返回一次**。
- `PAYLOAD_ENCRYPTION_KEY` — 必须 **32 字节 hex（64 个十六进制字符）**，AES-256-GCM 用，改密后历史密文不可读。
- `MAIL_PROVIDER` — `smtp | http | pickup | json`（dev 默认 json，落盘不真发）。smtp 时注意 `SMTP_SECURE`（SSL 直连用 `"true"`，否则按 465 推断）与 `SMTP_TLS_REJECT_UNAUTHORIZED`（证书信任 \* 设为 `"false"`）。

## 架构

### 分层与模块

`API route → modules/*/service → repository → Prisma`。业务模块在 `src/modules/`：
- `task/` — DTO（zod）校验 → SSRF 检查 → 敏感字段加密 → 落库；`payload`（url/method 非敏感）与加密的 `payloadSecrets`（**params/headers/body**）**分开存储**。http payload 结构：`url` + `method`(GET/POST/PUT/PATCH/DELETE/HEAD) + `params`(URL query 键值对，执行时并入 url，原 query 保留、同名覆盖) + `headers` + `body`。任务落 `owner_token_id`（创建者 token，租户内按 token 隔离视图用；写权限仍按租户共享）。
- `execution/` — 执行器按 `taskType` 注册（`register.ts` / `registry.ts`，当前 `http` / `noop`）；含超时、重试（maxAttempts）、状态机推进。
- `notification/` — outbox 落库（`email_log` / `webhook_delivery`）+ 终态判定。`notifyOn` 是邮件与 webhook 的**统一**通知开关（2026-08-25 起 webhook 同受其约束，timeout/dead 按 failed 归类），勿只给邮件加判断。
- `webhook/` — 出站签名 `X-Scheduled-Signature: t=<unix>,v1=<hmac>`。
- `auth/`、`tenant/` — token 校验、引导租户。

通用设施在 `src/lib/`：`config`（环境解析）、`cron`（解析/next-run/调度互斥校验）、`crypto`（AES-256-GCM）、`ssrf`、`db`、`logger`（pino）、`retry`、`metrics`（prom-client）、`api-envelope`（统一响应信封装）、`openapi`。邮件经 `src/mail/port.ts` 端口 + 适配器实现（smtp/http/pickup/json）。

### 调度模型（`src/lib/cron.ts` + `worker/scheduler.ts`）

- 调度方式三选一：`cron`（5/6/7 段，7 段为 Quartz 式 `秒 分 时 日 月 周 年`；按任务 `timezone` 列解析，默认 `Asia/Shanghai`）**或** `scheduleIntervalSeconds`（固定间隔，顺延语义）**或** `runAt`（一次性绝对时刻，跑完自动停用），DTO 层 `isValidScheduleTriple` 强制恰有一个非空；`retryDelayMs` 为同次调度内重试等待基线（null=默认 1s×2/30s 封顶退避）；`overlapPolicy`（skip/queue/run，默认 skip=今天行为）控制上次未结束时下次到点的行为；`endsAt`/`maxRuns` 为结束规则（可共存，谁先到谁停；仅重复调度，一次性任务禁配）。
- Worker 每轮单事务领取到期任务 → 写租约（`claimed_by` / `claimed_until`）→ 推进 `next_run_at`；`SELECT ... FOR UPDATE SKIP LOCKED`（**版本探测**：MySQL <8.0.1 / MariaDB <10.6 不支持时自动退化为「条件 UPDATE + 受影响行数」的可移植领取，多实例仍恰好一次）。
- **执行与领取解耦**（`worker/runner.ts`）：`runLoop` 每轮只按并发池 `freeSlots` 领取数量、`runner.submit()` 入池立即返回——单条长任务/流式只占自己的并发槽，不阻塞其他任务领取执行；邮件/Webhook 中继走独立后台通道（`relayLoop`），不进领取关键路径。**关机**：SIGTERM 先排空，超 `SHUTDOWN_GRACE_MS` 对在途任务 abort（`shutdownController`）。
- **租约续期 + 孤儿对账**：heartbeat（≈10s）对运行中任务续 `claimed_until`（只续 `claimed_by=自己` 的行，`renewTaskLeases`），长任务不丢租约→不被别实例重复领取；`reconcileOrphanExecutions` 把租约过期的 `running` 执行整定为 failed（**不重跑**，防双副作用）并清过期认领。
- **补跑语义**：调度层停机期间错过的到期**不补跑**（`advanceMissedRuns` 只推进 `next_run_at`）；执行层 `pending` 执行行（run-now，或故障死窗口遗留的陈旧行，创建超 5s 宽限 `PENDING_RECLAIM_GRACE_SECONDS`）重启后被重新领取执行（补跑）；`reclaimExpiredLeases` 清扫过期租约。
- 手动运行（`run-now`）：入队 `status='pending'` 执行行，由 worker 领取。
- 乐观并发：`version` 字段，更新冲突 → 409。

### 鉴权（`src/modules/auth/`）

- 全部非公开端点走 `x-api-token` 头；DB 仅存 SHA-256 哈希，`timingSafeEqual` 比对。**例外（单默认租户临时约定）**：`POST /api/v1/tokens` 签发免鉴权（不查头、不查 scope），token 归 default 租户（`createdBy: "anonymous"`）；多租户落地时恢复 `requireAuth({ scopes: ["tokens:manage"] })`，列表/吊销/自查仍走 `tokens:manage`。
- `requireAuth({ scopes })` / `optionalAuth` 包装 route handler（`middleware.ts`）。scope 缺失 → **403 `missing scope: <name>`**；scope：`tasks:read` / `tasks:write` / `tokens:manage`。
- 所有查询强制 `tenant_id`；跨租户一律 **404**。

### 通知幂等

outbox 表按 `run_id` UNIQUE；执行、邮件、Webhook 各自以 run_id 串联，中继可安全重试。任务重跑由 `idempotency_key`（run_id）去重。

### 安全要点

- SSRF（`src/lib/ssrf.ts`）：拒绝 loopback / RFC1918 / link-local / 元数据 IP，DNS 复核，重定向 ≤3 且逐跳复查；`SSRF_ALLOW_PRIVATE=true` 放行私网 IP、`SSRF_ALLOW_LOCALHOST=true` 额外放行 localhost 主机名——**内网自用部署两者设 true**（任务/回调目标都是内网地址），元数据主机名等结构检查始终保留。
- 敏感字段加密存储（payload secrets / webhook secret），明文不入库、不打日志。
- `security-reviewer` 技能适用于该模块改动。

## 测试

- **单元**（`tests/unit/`）：纯函数/工具（cron、crypto、tokens、ssrf、api-envelope、schedule-builder 等），无 DB。
- **集成**（`tests/integration/`）：需 `docker compose up -d` 的 MySQL 8（宿主 13306，凭据 `scheduler/changeme`，库 `scheduled`）。助手函数在 `tests/integration/helpers.ts`：`createTestTenant` / `createTestToken(tenantScopes)` / `createTestTask` / `cleanupTenant`——新建用例尽量复用。
- **E2E**（`tests/e2e/smoke.spec.ts`，Playwright）：**需 web + worker 均已运行**。
- 单跑一个文件：`npx vitest run tests/unit/cron.test.ts`。
- 覆盖率门禁（vitest.config.ts）：line 60% / function 55% / branch 45% / statement 60%；`src/app/**`、`openapi.ts`、`worker/index.ts` 等已排除。
- 测试环境变量在 `tests/setup.ts` 兜底填充（`??=`，项目 `.env` 优先）。

## 注意事项（易踩坑）

- **worker 进程生命周期**：`SKIP LOCKED` 只保证"多实例并发领取安全"，**不保证"旧代码被换掉"**。部署/重启后务必确认没有残留的旧 worker（non-watch 的 `npx tsx worker/index.ts`、PM2 旧实例、多个 dev 进程可能并存）——旧代码 worker 会继续领取并误停任务（2026-08-21 事故根因：一个 9:14 启动、非 watch 的 worker 一直跑修复前代码，把任务逐个停用）。
- **时区约定（2026-08-24 起固定）**：容器 `TZ: Asia/Shanghai`（`docker exec` 看库为 +08），但**应用会话经 `DATABASE_URL?...&timezone=Z` 强制 UTC**——调度比较（`NOW()` 与写入的 `next_run_at`）一律按 UTC 自洽。原因：Prisma 7 driver-adapter 把 JS Date 序列化为 UTC 固化值、不受进程 TZ 影响，若与服务器时钟基准不同会差 8h；容器 +08 只是运维可见性。**裸 `mysql2` 默认 `timezone:'local'`，传 JS Date 产生 ±8h 偏移**（曾致恢复任务延后 8 小时才到期）——运维/恢复脚本请用 SQL 端时间（`DATE_ADD(NOW(), ...)`）或走 Prisma，不要裸 mysql2 传 Date。改连接串时勿删 `timezone=Z`。**对外时间戳契约（2026-08-25 起）**：存储保持 UTC，但 REST 响应、完成邮件、webhook payload 里的时间一律序列化为带 `+08:00` 偏移的 ISO 8601（北京时间）——REST 在 `api-envelope.ts` 的 `ok()` 经 `src/lib/datetime.ts`（luxon）收口，邮件/webhook 在 `notification/service.tsx` 用 `toBeijingIso`；前端 `toLocaleString()` 直接可用，勿在展示层再手写 UTC 转换。幂等键里的 `toISOString()` 是内部标识，勿改成带偏移格式。
- **改 `worker/` 的调度/领取逻辑**：必须考虑 SKIP LOCKED 并发（不支持时自动退化为条件 UPDATE 领取）、租约超时回收、不补跑语义；改 schema 后跑 `prisma:generate` + `migrate`。
- **HTTP 执行器结果日志（`src/modules/execution/executors/http.ts`）**：2xx 结果完整写入 logger（`http task ok`）；流式响应按 content-type 自动识别——`text/event-stream`→SSE 逐 event（取 `data:` 行）、`ndjson`/`jsonl`/`stream+json`→逐行，逐步记录（`http stream event`）+ 汇总（`http stream complete`），**接口完整跑完后才发终态邮件**。**流式超时是空闲超时**：执行器每次读到 chunk 调 `onProgress()` 续命 `withTimeout`，连续 `timeoutMs` 无数据才中止，非流式维持总时长。改日志时注意：url 只记 origin+pathname（并入的 query params 属加密 secrets，别重新引入明文日志）。
- **任务表单/回显**：任务只用 `cron` 字符串字段存储；结构化界面（`src/components/tasks/ScheduleBuilder.tsx` + `src/lib/schedule-builder.ts`）在前端做「结构化 spec ↔ cron 字符串」双向转换，编辑回显时同样在前端反解。
- API 路由文件用 `@/`（→ `src`）与 `@worker`（→ `worker`）别名；import 别用相对路径跨大目录。
- 错误模型：`src/lib/errors.ts` 的 `AppError` → HTTP 状态映射；统一走 `api-envelope` 响应格式，不要直接 `NextResponse.json` 裸返回。
- **MDX 文档页（Web 控制台 `/docs`，「接口文档」）**：`@next/mdx` 配置在 `next.config.ts`（`pageExtensions` 含 md/mdx；Turbopack 下 remark/rehype 插件必须用**字符串名**）。全局组件映射放 **`src/mdx-components.tsx`**（不是 `src/app/` 下——放错会回退到 `@mdx-js/react` 导致 RSC `createContext` 报错），导出 `useMDXComponents` 并把 `Note`/`Warn`/`Danger`/`PreBlock`（`src/components/docs/pre-block.tsx`，复制按钮）注册进 components。正文在 `src/app/(web)/docs/page.mdx`；**左侧吸顶目录在 `(web)/docs/layout.tsx`**（锚点与正文 `<h2 id>` 一一对应，改标题要同步）；接口表格可用 `<Method method="GET" />` 徽标。MDX 行内代码里**不要嵌套反引号**（会与定界符冲突被解析成 JS 表达式）。新增接口记得：更新 `page.mdx` 的接口清单「调用示例」列（每行一行真实 curl，含示例 token 与 `localhost:3000`），并在 `(web)/layout.tsx` 的 `NAV_ITEMS` 登记导航。
- 生产不用 console.log（pino logger，见 hooks 规则）。