# 定时任务系统 — 近期改动与接口参数手册

> 覆盖自 2026-09-09 起的全部改动，以及创建任务接口 POST /api/v1/tasks 的完整参数说明。
> 面向开发者和对接方，按参数维度组织，可直接作为对接参考。

---

# 第一部分：改动总结

## 新增了什么

### 调度能力

- 一次性任务：新增 runAt 参数，指定一个绝对时刻只跑一次，跑完自动停用
- 每任务独立时区：新增 timezone 参数，cron 表达式按各自时区解析（默认 Asia/Shanghai）
- 7 段 cron：cron 从 5/6 段扩展到 7 段（Quartz 式 秒 分 时 日 月 周 年），支持年份字段
- 开始/截止时刻：startsAt 控制重复任务何时首跑；endsAt 控制何时停止
- 总次数上限：maxRuns 限制调度触发的总次数（手动触发、重试、跳过不计）
- 重叠策略：overlapPolicy 控制上次还没跑完、下次又到点时的行为（跳过/排队/并行）
- 节假日跳过/顺延：skipHolidays + holidayPolicy，到点遇节假日可作废或顺延到下一工作日
- 可配重试等待：retryDelayMs 自定义重试间隔基线，封顶随基线走（不再被 30s 钳住）

### 执行能力

- 流式响应：HTTP 执行器自动识别 SSE / NDJSON 流式响应，逐 event/行记录，空闲超时（无进展才超时）
- 执行与领取解耦：runner 改为 submit 入池即返回，单条长任务不阻塞其他任务领取
- 租约续期 + 孤儿对账：运行中任务自动续租约防双跑；崩溃遗留的 running 执行整定为 failed 不重跑

### 通知能力

- 邮件模板：emailSubjectTemplate / emailBodyTemplate / emailAttachmentUrlTemplate，支持 {path} 占位符从响应数据取值渲染
- succeeded_with_results：notifyOn 新增此值，有结果数据时才发通知
- 中继回收：认领后 10 分钟未完成的 in_progress 邮件/webhook 自动回收重投

### 安全与对接

- 回调签名（对接 sqleditor）：HTTP 执行请求在配置 TASK_CALLBACK_SIGN_SECRET 后自动附带三个签名头：
  - X-Scheduled-Signature：t=<unix时间戳>,v1=<hmac-sha256(t.<rawBody>,secret)>，与 webhook 出站签名同构
  - X-Execution-Id：本次执行的 runId（execution.id），供对方幂等对账
  - X-Trigger-Type：触发类型，1=定时调度 / 2=手动触发 / 3=失败后重试
  密钥优先级：env 共享密钥 > 任务级 execSignSecret > 不签名
- 密钥交接 API：POST /api/v1/tasks/[id]/sign-secrets 读取/轮换任务签名密钥
- 用户追踪：systemUserId 贯穿 Task / Execution / EmailLog / WebhookDelivery，可按用户隔离视图

### 部署

- OceanBase 兼容：纯 JS 迁移 runner 替代 Prisma migrate，容器启动自动迁移 + seed
- 节假日 API 对接：按真实请求/响应格式适配内网节假日接口

## 时间格式做了什么

- 存储层：一律 UTC（连接串 timezone=Z 强制），不变
- 对外出口（REST 响应、邮件、webhook）：统一序列化为带 +08:00 偏移的北京时间 ISO 8601
- 入参：要求 ISO 8601 带偏移（Z 或 +08:00 均可）
- 幂等键：内部 toISOString()（Z 格式）有意保留不改

---

# 第二部分：创建任务接口参数手册

> 接口：POST /api/v1/tasks
> 鉴权：需 Bearer Token，scope 含 tasks:write
> Content-Type：application/json
> systemUserId 特殊入口：可通过请求头 x-system-user-id 传入（头优先于 body 字段）
> 定义文件：DTO 见 src/modules/task/dto.ts，Schema 见 prisma/schema.prisma

## 一、调度方式（三选一，恰好一个非空）

创建任务必须指定一种调度方式，三种互斥，有且仅有一个生效。

### 1. cron — cron 表达式重复调度

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 与下面两者三选一 |
| 格式 | 5/6/7 段，空格分隔 |
| 默认值 | 无 |

**格式说明**：

| 段数 | 字段顺序 | 示例 | 引擎 |
|------|----------|------|------|
| 5 段 | 分 时 日 月 周 | 0 9 * * 1-5（工作日 9 点） | cron-parser |
| 6 段 | 秒 分 时 日 月 周 | 0 0 9 * * 1-5（工作日 9:00:00） | cron-parser |
| 7 段 | 秒 分 时 日 月 周 年 | 0 0 9 1 1 * 2099（2099 年 1 月 1 日 9 点） | croner |

**示例**：

```json
"cron": "0 9 * * 1-5"
```

**注意**：按 timezone 字段解析；7 段含年份字段，cron-parser 不支持故走 croner 引擎。

### 2. scheduleIntervalSeconds — 固定间隔重复调度

| 属性 | 值 |
|------|------|
| 类型 | integer（可选） |
| 是否必传 | 与上面两者三选一 |
| 格式 | 正整数，单位秒，最小 1 |
| 默认值 | 无 |

**示例**：

```json
"scheduleIntervalSeconds": 60
```

**注意**：固定间隔无钟表概念，传 timezone 会被拒绝（400）。每次执行完成后隔 N 秒再触发下一次。

### 3. runAt — 一次性绝对时刻

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 与上面两者三选一 |
| 格式 | ISO 8601 带时区偏移，必须未来时刻 |
| 默认值 | 无 |

**合法示例**：

```json
"runAt": "2026-09-12T10:00:00.000+08:00"
"runAt": "2026-09-12T02:00:00.000Z"
```

**非法示例**：

```json
"runAt": "2026-09-12T10:00:00"    // 缺偏移，400
"runAt": "2026-09-12 10:00"        // 非 ISO，400
"runAt": "2026-09-01T10:00:00Z"    // 过去时刻，400
```

**注意**：跑完自动 enabled=false 停用；禁止配 endsAt/maxRuns/overlapPolicy/startsAt/skipHolidays/holidayPolicy。

---

## 二、调度辅助参数

### timezone — 任务时区

| 属性 | 值 |
|------|------|
| 类型 | string |
| 是否必传 | 否 |
| 格式 | IANA 时区名 |
| 默认值 | Asia/Shanghai |

**示例**：

```json
"timezone": "Asia/Shanghai"
"timezone": "UTC"
"timezone": "America/New_York"
```

**含义**：cron 表达式和 runAt 的墙钟解析用此时区。仅对 cron 和 runAt 有意义，配 scheduleIntervalSeconds 同时传 timezone 会被拒绝。

### startsAt — 重复调度开始时刻

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | ISO 8601 带时区偏移，必须未来 |
| 默认值 | 无（立即开始） |

**示例**：

```json
"startsAt": "2026-09-15T00:00:00.000+08:00"
```

**含义**：重复调度（cron/interval）的首次触发不早于此时刻。仅重复调度可配，runAt 一次性任务禁止配。

### endsAt — 重复调度截止时刻

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | ISO 8601 带时区偏移，必须未来 |
| 默认值 | 无（不自动停） |

**示例**：

```json
"endsAt": "2026-12-31T23:59:59.000+08:00"
```

**含义**：重复调度到达此时刻后停止（enabled=false）。与 maxRuns 可共存，谁先到谁停。仅重复调度可配。

### maxRuns — 总执行次数上限

| 属性 | 值 |
|------|------|
| 类型 | integer（可选） |
| 是否必传 | 否 |
| 格式 | 1 到 1,000,000 的整数 |
| 默认值 | 无（不限） |

**示例**：

```json
"maxRuns": 100
```

**含义**：调度触发的总次数达到此值后停止。只统计调度触发，手动 run-now、重试、跳过（skipped）不计。仅重复调度可配。

### overlapPolicy — 重叠策略

| 属性 | 值 |
|------|------|
| 类型 | string |
| 是否必传 | 否 |
| 格式 | 枚举：skip / queue / run |
| 默认值 | skip |

**枚举含义**：

| 值 | 行为 |
|----|------|
| skip | 上次未结束时，本次到点跳过（写 skipped 审计行，不计入 maxRuns） |
| queue | 上次未结束时，本次排队等上次跑完再执行 |
| run | 上次未结束时，允许本次并行执行 |

**示例**：

```json
"overlapPolicy": "queue"
```

**注意**：仅重复调度可配，runAt 一次性任务禁止配。

### skipHolidays — 是否跳过节假日

| 属性 | 值 |
|------|------|
| 类型 | boolean |
| 是否必传 | 否 |
| 格式 | true / false |
| 默认值 | false |

**示例**：

```json
"skipHolidays": true
```

**含义**：到点时先查节假日 API，如是假日则按 holidayPolicy 处理。需配置 HOLIDAY_API_URL 环境变量，否则任务创建/更新时返回 400。仅重复调度可配。

### holidayPolicy — 节假日处理策略

| 属性 | 值 |
|------|------|
| 类型 | string |
| 是否必传 | 否 |
| 格式 | 枚举：drop / postpone |
| 默认值 | drop |

**枚举含义**：

| 值 | 行为 |
|----|------|
| drop | 遇假日直接作废该次触发，不补跑 |
| postpone | 顺延到下一个工作日的同一墙钟时刻执行 |

**示例**：

```json
"holidayPolicy": "postpone"
```

**注意**：只有 skipHolidays=true 时此参数才有效；传了非 drop 值但没开 skipHolidays 会被拒绝（400）。

---

## 三、重试与超时参数

### maxAttempts — 最大尝试次数

| 属性 | 值 |
|------|------|
| 类型 | integer |
| 是否必传 | 否 |
| 格式 | 1 到 10 的整数 |
| 默认值 | 3 |

**示例**：

```json
"maxAttempts": 5
```

**含义**：含首次执行在内，单次调度的最大尝试次数。4xx（除 429）视为永久失败不重试；5xx / 429 / 连接错误 / 超时视为可重试。

### timeoutMs — 单次执行超时

| 属性 | 值 |
|------|------|
| 类型 | integer |
| 是否必传 | 否 |
| 格式 | 1000 到 3,600,000 的整数（毫秒） |
| 默认值 | 30000（30 秒） |

**示例**：

```json
"timeoutMs": 60000
```

**含义**：单次 HTTP 请求的最大允许时间。流式响应（SSE/NDJSON）按空闲计时——只要持续有数据到达就不超时，连续 N 毫秒无进展才超时。

### retryDelayMs — 重试等待基线

| 属性 | 值 |
|------|------|
| 类型 | integer（可选） |
| 是否必传 | 否 |
| 格式 | 0 到 3,600,000 的整数（毫秒） |
| 默认值 | null（沿用默认退避） |

**示例**：

```json
"retryDelayMs": 5000
```

**含义**：同次调度内重试的等待基线。null=默认退避（1s 基线 x2 指数抖动，30s 封顶）；自定义值时封顶取 max(30s, 基线)，不再被 30s 钳住。0=失败即重试。

---

## 四、执行参数

### taskType — 任务类型

| 属性 | 值 |
|------|------|
| 类型 | string |
| 是否必传 | 否 |
| 格式 | 枚举：http / noop |
| 默认值 | http |

**示例**：

```json
"taskType": "http"
```

**含义**：http 执行 HTTP 请求（需配 payload）；noop 空操作，不允许携带 payload。

### payload — 任务负载

| 属性 | 值 |
|------|------|
| 类型 | object |
| 是否必传 | taskType=http 时必传；noop 不可传 |
| 格式 | 见下方结构 |
| 默认值 | 无 |

**payload 结构（taskType=http）**：

```json
{
  "url": "https://example.com/api",
  "method": "POST",
  "params": { "key": "value", "count": 123, "flag": true },
  "headers": { "Authorization": "Bearer xxx" },
  "body": "raw string"
}
```

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| url | string(URL) | 是 | 执行目标地址；SSRF 校验（结构+DNS），重定向最多 3 跳且每跳重新校验 |
| method | enum | 否 | GET(默认) / POST / PUT / PATCH / DELETE / HEAD |
| params | Record<string, string|number|boolean> | 否 | URL query 参数，执行时并入到问号后面，同名键覆盖原 URL 的 |
| headers | Record<string, string> | 否 | 自定义请求头 |
| body | string | null | 否 | 请求体（必须是字符串）；如需发 JSON，自己 stringify 后传字符串 |

**注意**：params / headers / body 中的敏感值会加密存储（payload_secrets），日志中不出现明文。URL 日志只记 origin+pathname。

### enabled — 是否启用

| 属性 | 值 |
|------|------|
| 类型 | boolean |
| 是否必传 | 否 |
| 格式 | true / false |
| 默认值 | true |

**示例**：

```json
"enabled": true
```

**含义**：是否参与 worker 领取调度。runAt 一次性任务跑完后自动置 false。可随时手动启用/停用。

---

## 五、通知参数

### recipients — 通知收件人

| 属性 | 值 |
|------|------|
| 类型 | string[] |
| 是否必传 | 是 |
| 格式 | 合法 email 地址数组，至少 1 个 |
| 默认值 | 无 |

**示例**：

```json
"recipients": ["ops@example.com", "dev@example.com"]
```

**含义**：任务执行后通知的收件人邮箱列表。即使不配邮件模板，默认也有系统标题和正文。

### notifyOn — 通知触发状态

| 属性 | 值 |
|------|------|
| 类型 | string[] |
| 是否必传 | 否 |
| 格式 | 枚举数组：succeeded / failed / succeeded_with_results |
| 默认值 | ["succeeded", "failed"] |

**枚举含义**：

| 值 | 含义 |
|----|------|
| succeeded | 执行成功就通知 |
| failed | 执行失败就通知 |
| succeeded_with_results | 执行成功且有结果数据时才通知（配合附件模板使用） |

**示例**：

```json
"notifyOn": ["succeeded_with_results", "failed"]
```

**含义**：控制哪些终态触发邮件/webhook。email 和 webhook 各自独立门控（webhook 只在 notifyOn 包含的状态触发）。

### webhookUrl — 出站 webhook 地址

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | 合法 URL |
| 默认值 | 无 |

**示例**：

```json
"webhookUrl": "https://myapp.com/hooks/task-done"
```

**含义**：任务执行后在 notifyOn 门控下向此地址 POST webhook payload。webhook 带签名头（与 email 各自独立）。不配则不发 webhook。

### 邮件模板参数（三个，均可选）

#### emailSubjectTemplate

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | 最长 255 字符，支持 {path} 占位符 |
| 默认值 | 无（用系统默认标题） |

#### emailBodyTemplate

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | 最长 10,000 字符，支持 {path} 占位符 |
| 默认值 | 无（用系统默认正文） |

#### emailAttachmentUrlTemplate

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | 最长 512 字符，支持 {path} 占位符 |
| 默认值 | 无（不带附件） |

**占位符渲染规则**：{path.to.field} 按点号路径从 HTTP 响应 JSON 中取值替换。

| 情况 | 渲染结果 |
|------|----------|
| 找到值（基本类型） | 替换为 toString 结果 |
| 值为 null | 替换为空串 |
| 值为 object | 替换为 JSON.stringify 结果 |
| 没找到 | 保留原始 {xxx} 不变，并打 warn 日志 |

**示例**：

```json
{
  "emailSubjectTemplate": "任务 {taskName} 执行完成",
  "emailBodyTemplate": "状态：{status}，耗时：{durationMs}ms",
  "emailAttachmentUrlTemplate": "https://example.com/report/{data.reportId}.pdf"
}
```

**注意**：不支持条件/循环，要复杂逻辑走 webhook 自渲染。附件 URL 渲染后持久化到 EmailLog，中继投递时下载。

---

## 六、追踪参数

### systemUserId — 系统内用户标识

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | 最长 191 字符 |
| 默认值 | 无 |

**传入方式（两种，头优先）**：

方式一：通过请求头传入

```http
POST /api/v1/tasks HTTP/1.1
Authorization: Bearer <token>
x-system-user-id: user-12345
Content-Type: application/json

{ "name": "my-task", ... }
```

方式二：放在 body 中

```json
"systemUserId": "user-12345"
```

**含义**：标识外部接入系统中的具体用户。贯穿存储到 Task / TaskExecution / EmailLog / WebhookDelivery，列表查询可按 system_user_id 过滤。如同时通过头和 body 传入，头的值优先。

---

## 七、时间格式约定

系统分三层处理时间，每层格式不同：

### 入参层（你 -> API）

runAt / startsAt / endsAt 这三个参数：

- 必须是 ISO 8601 格式且带时区偏移
- Z（UTC）和 +08:00（北京时间）都可以
- 不带偏移的裸时间会被拒绝（400）
- 必须是未来时刻（创建时校验）

| 格式 | 示例 | 是否合法 |
|------|------|----------|
| UTC 带 Z | 2026-09-12T02:00:00.000Z | 合法 |
| 北京时间带偏移 | 2026-09-12T10:00:00.000+08:00 | 合法 |
| 无偏移 | 2026-09-12T10:00:00 | 非法（400） |
| 非 ISO | 2026-09-12 10:00 | 非法（400） |

前端表单用 datetime-local 收集墙钟时间，用 luxon 按所选 timezone 解析后转 UTC（Z 后缀）提交。直接调 API 两种格式均可。

### 出参层（API -> 你）

所有响应中的时间字段（如 nextRunAt、createdAt、startedAt 等）：

- 统一输出为带 +08:00 偏移的北京时间 ISO 8601
- 示例：2026-08-25T10:00:00.000+08:00
- 实现入口：src/lib/datetime.ts 的 toBeijingIso + serializeDates，在 REST 响应出口统一收口

### 存储层（内部）

- 数据库存 UTC（连接串 timezone=Z 强制应用会话 UTC）
- 调度比较（NOW() vs next_run_at）一律 UTC 自洽
- 幂等键内部用 toISOString()（Z 格式），有意不改（改了会破坏幂等语义）

---

## 七补、出站执行请求签名头

当 HTTP 任务执行请求发出时，如果配置了 `TASK_CALLBACK_SIGN_SECRET` 环境变量（或任务自身有 execSignSecret），会自动在请求头中附带以下三个头，供接收方验签和对账：

### X-Scheduled-Signature — 请求签名

| 属性 | 值 |
|------|------|
| 出现条件 | 配置了 TASK_CALLBACK_SIGN_SECRET 或任务 execSignSecret |
| 格式 | t=<unix时间戳>,v1=<hex签名> |

**签名算法**：`HMAC-SHA256(key=密钥, message=时间戳 + . + 实际发出的 body)`

**示例**：

```http
X-Scheduled-Signature: t=1726012800,v1=a1b2c3d4e5f6...
```

**验签步骤**（接收方）：

1. 从头值解析 t 和 v1（逗号分隔，t= 前缀是时间戳，v1= 前缀是签名）
2. 用共享密钥对 `<t>.<收到的原始 body>` 做 HMAC-SHA256，比对 v1（timing-safe compare）
3. 检查时间戳 t 与当前时间的差值在容忍窗内（对方约定 300 秒）
4. 空 body 按空字符串参与签名（即签 `t.`）

### X-Execution-Id — 执行标识

| 属性 | 值 |
|------|------|
| 出现条件 | 同上（有签名密钥时附带） |
| 格式 | 字符串，即本次执行的 execution.id（runId） |

**示例**：

```http
X-Execution-Id: clxabc123def456
```

**含义**：本次执行记录的唯一标识。接收方可用此做幂等去重——同一个 runId 的重复请求应忽略。

### X-Trigger-Type — 触发类型

| 属性 | 值 |
|------|------|
| 出现条件 | 同上 |
| 格式 | 整数：1 / 2 / 3 |

**枚举含义**：

| 值 | 含义 |
|----|------|
| 1 | 定时调度触发（cron/interval/runAt 到点） |
| 2 | 手动触发（调用 run-now API） |
| 3 | 失败后重试（前次失败，自动重试的后续 attempt） |

**示例**：

```http
X-Trigger-Type: 1
```

**密钥优先级**：`TASK_CALLBACK_SIGN_SECRET`（env 共享密钥） > 任务 `execSignSecret`（任务级密钥，Phase 2 对方按任务验签后启用） > 无密钥则不附带签名头。

**注意**：这三个头只在出站 HTTP 执行请求上附带（即调度平台作为 client 主动发出的请求），不是 REST API 的入站鉴权。签名值和密钥永不进日志。

---

## 八、环境变量汇总

以下环境变量与上述参数配合使用：

| 环境变量 | 默认值 | 是否必填 | 关联参数 | 说明 |
|----------|--------|----------|----------|------|
| HOLIDAY_API_URL | — | skipHolidays=true 时必填 | skipHolidays / holidayPolicy | 节假日查询接口地址（不含 appKey） |
| HOLIDAY_API_APP_KEY | — | 同上 | 同上 | appKey（单独配，避免进日志） |
| HOLIDAY_API_TIMEOUT_MS | 5000 | 否 | 同上 | 节假日接口超时，范围 1000-30000ms |
| TASK_CALLBACK_SIGN_SECRET | — | 否 | taskType=http 执行签名 | sqleditor 回调签名共享密钥；不配则回退任务级 execSignSecret，都不配则不签名 |
| SHUTDOWN_GRACE_MS | — | 否 | worker 运维 | 优雅关停排空超时，超时后对在途任务 abort |
| PENDING_RECLAIM_GRACE_SECONDS | 5 | 否 | worker 运维 | pending 执行行重新领取宽限秒数 |

---

## 九、常见 400 校验错误

创建/更新任务时常见的校验失败：

| 错误消息 | 原因 |
|----------|------|
| exactly one of cron, scheduleIntervalSeconds or runAt is required | 三种调度方式传了 0 个或 >1 个 |
| invalid cron expression | cron 语法非法 |
| runAt must be an ISO 8601 datetime | runAt 不是合法的带偏移 ISO 字符串 |
| runAt must be in the future | runAt 是过去时刻 |
| endsAt must be an ISO 8601 datetime | endsAt 格式不对 |
| endsAt must be in the future | endsAt 是过去时刻 |
| startsAt must be an ISO 8601 datetime | startsAt 格式不对 |
| startsAt must be in the future | startsAt 是过去时刻 |
| timezone is only meaningful with cron or runAt | interval 调度同时传了 timezone |
| unknown IANA timezone | timezone 不是合法 IANA 时区名 |
| run-once tasks take no end rules, startsAt, holiday rules or overlap policy | runAt 任务传了重复调度专属参数 |
| holidayPolicy requires skipHolidays=true | holidayPolicy 非 drop 但没开 skipHolidays |
| at least one recipient | recipients 为空数组 |
| invalid recipient email | recipients 中有非邮箱格式 |
| payload.url must be a valid URL | payload.url 不是合法 URL |
| payload.method must be a standard HTTP method | method 不是枚举值 |
| noop task must not carry a payload | taskType=noop 同时传了 payload |

---

## 附：完整创建请求示例

```json
{
  "name": "每日数据导出",
  "cron": "0 18 * * 1-5",
  "timezone": "Asia/Shanghai",
  "startsAt": "2026-09-15T00:00:00.000+08:00",
  "endsAt": "2026-12-31T23:59:59.000+08:00",
  "maxRuns": 100,
  "overlapPolicy": "queue",
  "skipHolidays": true,
  "holidayPolicy": "postpone",
  "retryDelayMs": 5000,
  "maxAttempts": 5,
  "timeoutMs": 60000,
  "taskType": "http",
  "payload": {
    "url": "https://internal-api.example.com/export",
    "method": "POST",
    "params": { "format": "csv" },
    "headers": { "Authorization": "Bearer xxx" },
    "body": "raw string"
  },
  "enabled": true,
  "recipients": ["ops@example.com"],
  "notifyOn": ["succeeded_with_results", "failed"],
  "webhookUrl": "https://myapp.com/hooks/export-done",
  "emailSubjectTemplate": "导出完成：{data.fileName}",
  "emailBodyTemplate": "导出状态 {status}，耗时 {durationMs}ms",
  "emailAttachmentUrlTemplate": "https://files.example.com/{data.fileId}.csv",
  "systemUserId": "user-12345"
}
```
