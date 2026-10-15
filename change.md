### 通知能力

- 邮件模板：emailSubjectTemplate / emailBodyTemplate / emailAttachmentUrlTemplate，支持 {path} 占位符从响应数据取值渲染
- 失败专用模板：emailSubjectTemplateFailed / emailBodyTemplateFailed（null=回退成功模板）
- 业务成败自动判定：HTTP 2xx 且包体含 `code` 时仅数字 200 算成功，其余失败（`msg` 作失败原因，不重试）；无 `code` 包体保持成功
- 模板派生字段：statusText（成功/失败）、failureReason、previewTableHtml（前 20 行表格）、previewNote、fileSizeText、fileDesc，另有中文别名（任务名称/执行状态/失败原因/结果总数量/文件格式/预览行数/预览结果表格/文件说明/文件链接/站内链接/执行时间）
- 默认邮件正文精简：仅 Run / Status / Task / Scheduled / Duration（去 Error 行与站内链接 footer）
- succeeded_with_results：notifyOn 新增此值，有结果数据时才发通知
- 中继回收：认领后 10 分钟未完成的 in_progress 邮件/webhook 自动回收重投
- webhook 判定解耦（V3）：只看有没有配 `webhookUrl`，有即每个终态必发，不再受 `notifyOn` / `recipients` 约束（后两者只控制邮件）
- webhook 固定密钥签名（V3）：终态回调改用服务端 `TASK_CALLBACK_SIGN_SECRET` 签名，只发两头 `X-Scheduled-Signature` + `X-Execution-Id`（不要 `X-Trigger-Type`）；未配密钥即裸发（与任务执行请求一致）；per-task `webhookSecret` 已退场（不再生成/轮换，读恒 null）
- webhookUrl 入参与 `payload.url` 同规则做 SSRF 校验（创建/修改时拦，投递前与重定向逐跳复查保留）
- webhook payload 新增 `nextRunAt`（下次触发，北京时间 ISO；无后续运行为 null）与 `disabledReason`（停用原因，未停用为 null），终态写入前按任务行快照取值
- 自定义邮件正文自动美化：模板换行保留为换行，纯文本形态的 `{文件链接}` / `{站内链接}` 分别渲染成「下载附件」「查看详情」蓝色按钮（手写链接不动；纯文本版保留裸链接）；默认模板加成功/失败状态徽标与行间距
- 终态意图冻结审计：执行终态把“该不该发 + 用什么发的”（收件人/notifyOn/webhookUrl/模板/结果）记在 `task_execution` 上；渲染链抛错走纯字符串降级兜底（永不抛），“终态无通知行”在代码上不可能发生，故无自动补单（中继重试/stale 回收/手动 redrive 保留）

### 安全与对接

- 回调签名（对接 sqleditor）：HTTP 执行请求在配置 TASK_CALLBACK_SIGN_SECRET 后自动附带三个签名头：
  - X-Scheduled-Signature：t=<unix时间戳>,v1=<hmac-sha256(t.<rawBody>,secret)>，终态 webhook 复用同一固定密钥（只发前两头）
  - X-Execution-Id：本次执行的 runId（execution.id），供对方幂等对账
  - X-Trigger-Type：触发类型，1=定时调度 / 2=手动触发 / 3=失败后重试（仅任务执行请求带，终态 webhook 不带）
  密钥优先级：env 共享密钥 > 任务级 execSignSecret > 不签名（终态 webhook 只认 env 固定密钥，无则裸发）

## 时间格式做了什么

- 存储层：一律 UTC（连接串 timezone=Z 强制），不变
- 对外出口（REST 响应、邮件、webhook）：统一序列化为带 +08:00 偏移的北京时间 ISO 8601
- 入参：要求 ISO 8601 带偏移（Z 或 +08:00 均可）
- 幂等键：内部 toISOString()（Z 格式）有意保留不改

---

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

**注意**：跑完自动 enabled=false 停用；禁止配 endsAt/maxRuns/overlapPolicy/startsAt；可配 skipHolidays/holidayPolicy（撞假日 postpone 顺延、drop 作废即创建 400）。停用时响应字段 disabledReason=run_once_done（见九）。

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

**含义**：重复调度到达此时刻后停止（enabled=false）。与 maxRuns 可共存，谁先到谁停。仅重复调度可配。停用时响应字段 disabledReason=ends_at（见九）。

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

**含义**：调度触发的总次数达到此值后停止。只统计调度触发，手动 run-now、重试、跳过（skipped）不计。仅重复调度可配。已用次数看响应字段 consumedRuns（X / maxRuns 即进度）；停用时 disabledReason=max_runs（见九）。

**配额用尽后复活**：consumedRuns 是单调账本，编辑任务不会顺手清零。复活走 PATCH 显式 `resetConsumedRuns: true`（只能传 true，传 false 直接 400；仅停用态可调，启用态 400，操作记审计日志），常与 `enabled: true` 同包一次提交、原子复活。重启用时若配额仍用尽直接 400（“quota exhausted … raise maxRuns or reset quota first”），不会“启用又立刻死”。

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

**含义**：是否参与 worker 领取调度。runAt 一次性任务跑完后自动置 false。可随时手动启用/停用。手动停用时响应字段 disabledReason=manual（操作 token 记入 disabledBy）；重启用后停用原因三字段清空（见九）。

**重启用 fail-fast**：`enabled: true` 且当前停用时，服务端用生效后值校验，不过直接 400：配额用尽（`consumed>=maxRuns` 且本次没带 `resetConsumedRuns`）、截止已过（`endsAt` 不晚于首跑）、调度无未来运行。过了才重算 nextRunAt 并启用，不存在“启用成功、下轮又停用”的中间态。

---

## 五、通知参数

### recipients — 通知收件人

| 属性 | 值 |
|------|------|
| 类型 | string[] |
| 是否必传 | 否（缺席默认 `[]`） |
| 格式 | 合法 email 地址数组，可空数组 |
| 默认值 | `[]`（不要邮件通知） |

**示例**：

```json
"recipients": ["ops@example.com", "dev@example.com"]
```

**含义**：任务执行后通知的收件人邮箱列表。即使不配邮件模板，默认也有系统标题和正文。为空（或不传）时不写邮件 outbox、不发邮件，webhook 按 `notifyOn` 照发；想完全静默就收件人留空且不配 `webhookUrl`。

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

### 邮件模板参数（五个，均可选）

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

#### emailSubjectTemplateFailed — 失败专用标题

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | 最长 255 字符，支持 {path} 占位符 |
| 默认值 | 无（回退成功标题模板） |

#### emailBodyTemplateFailed — 失败专用正文

| 属性 | 值 |
|------|------|
| 类型 | string（可选） |
| 是否必传 | 否 |
| 格式 | 最长 10,000 字符，支持 {path} 占位符 |
| 默认值 | 无（回退成功正文模板） |

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

**上下文来源**：内层 `data` 字段平铺 + 系统/派生字段：`statusText`（成功/失败）、`failureReason`（外层 `msg` 优先）、`previewTableHtml`（预览表格前 20 行 HTML）、`previewRowsMail`、`previewNote`、`fileSizeText`、`fileDesc`；中文别名：`任务名称`、`执行时间`、`执行状态`、`失败原因`、`结果总数量`、`文件格式`、`预览行数`、`预览结果表格`、`文件说明`、`文件链接`、`站内链接`。

**业务成败自动判定**：HTTP 非 2xx 按原逻辑失败；HTTP 2xx 且包体含 `code` 时仅数字 `200` 算成功，其余全失败（`msg` 作失败原因，按永久错处理不重试）；包体无 `code` 则成功。无需任务配置。

**示例**：

```json
{
  "emailSubjectTemplate": "【SQL定时查询】{任务名称} · {执行状态}",
  "emailBodyTemplate": "结果共{结果总数量}行 {预览结果表格} 下载：{文件链接}",
  "emailSubjectTemplateFailed": "【SQL定时查询】{任务名称} · {执行状态}",
  "emailBodyTemplateFailed": "失败原因：{失败原因} 查看：{站内链接}",
  "emailAttachmentUrlTemplate": "{文件链接}"
}
```

**注意**：不支持条件/循环，要复杂逻辑走 webhook 自渲染。附件 URL 渲染后持久化到 EmailLog，中继投递时下载（≤2MB 内联附件，超限/失败自动降级只发链接）。默认邮件（无模板时）正文仅 Run / Status / Task / Scheduled / Duration。

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


## 八、常见 400 校验错误

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
| run-once tasks take no end rules, startsAt or overlap policy | runAt 任务传了 endsAt/maxRuns/startsAt/overlapPolicy（节假日除外，可配） |
| holidayPolicy requires skipHolidays=true | holidayPolicy 非 drop 但没开 skipHolidays |
| invalid recipient email | recipients 中有非邮箱格式 |
| payload.url must be a valid URL | payload.url 不是合法 URL |
| payload.method must be a standard HTTP method | method 不是枚举值 |
| noop task must not carry a payload | taskType=noop 同时传了 payload |

---

## 九、任务只读状态字段（响应：详情/列表/创建/更新都带）

任务是怎么结束的，直接看这三个字段（停用写时定夺，启用中为 null；重启用清空）：

| 字段 | 类型 | 说明 |
|------|------|------|
| disabledReason | string \| null | 停用原因，见下表 |
| disabledAt | string \| null | 停用时刻（+08:00 偏移 ISO） |
| disabledBy | string \| null | 停用人：手动=操作 tokenId，自动=worker 实例 id |

| disabledReason | 含义 |
|------|------|
| manual | 手动停止（PATCH enabled=false） |
| run_once_done | 仅执行一次自动停止（runAt 跑完） |
| ends_at | 到了截止时间停止的 |
| max_runs | 到了最大执行次数停止的 |
| no_future_schedule | 调度本身无未来运行（如 cron 年份已过） |
| unknown | 历史未知（本次变更前已停用的老数据回填值） |

执行进度与租约（同样只读，看“跑了多少 / 是不是还在跑”）：

| 字段 | 类型 | 说明 |
|------|------|------|
| consumedRuns | number | 已消耗配额（调度触发计；run-now/重试/跳过不计；归档不影响，永不复活）。`consumedRuns / maxRuns` 即进度 |
| claimedBy | string \| null | 当前领取该任务的 worker 实例 id；null=空闲 |
| claimedUntil | string \| null | 租约到期时间；过期可被回收重领 |

**示例**（到最大次数停止的任务详情片段）：

```json
{
  "enabled": false,
  "disabledReason": "max_runs",
  "disabledAt": "2026-09-17T10:35:35.126+08:00",
  "disabledBy": "wk-host-1234",
  "maxRuns": 5,
  "consumedRuns": 5,
  "claimedBy": null,
  "claimedUntil": null
}
```

**注意**：tenantId / ownerTokenId 不对外返回（租户隔离边界）。

### PATCH /api/v1/tasks/:id 新增字段 resetConsumedRuns

| 属性 | 值 |
|------|------|
| 类型 | 字面量 true（可选） |
| 是否必传 | 否（缺席=不重置） |
| 格式 | 只能传 `true`；传 `false` 直接 400，请省略 |

**规则**：仅停用态可调（启用态 400）；与本次其它写入（改规则/重启用）进同一条 version 条件更新，单语句原子。重置记审计日志（谁、何时、旧值→0）。典型复活一次提交：

```json
{ "resetConsumedRuns": true, "enabled": true, "version": 3 }
```

**注意**：编辑任务（改名、改规则、加截止）永远不会顺手清零计数器；并发两个同 version 的 PATCH 恰好一个成功（409），配额不会被双重置。

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
