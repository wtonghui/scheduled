import { z } from "zod";

/**
 * 环境变量解析（zod），启动 fail-fast 校验（约法：密钥仅经环境变量并校验存在性）。
 */
const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),

  APP_BOOTSTRAP_TOKEN: z.string().min(16),
  TOKEN_PREFIX: z.string().min(1).default("sche-"),

  // 32 字节 hex（64 字符）用于 AES-256-GCM
  PAYLOAD_ENCRYPTION_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "PAYLOAD_ENCRYPTION_KEY must be 32 bytes hex (64 chars)"),

  MAIL_PROVIDER: z.enum(["smtp", "http", "pickup", "json"]).default("json"),
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().min(1).default("Scheduler <noreply@example.com>"),
  SMTP_RATE_LIMIT: z.coerce.number().positive().optional(),
  SMTP_MAX_CONNECTIONS: z.coerce.number().int().positive().default(5),
  SMTP_TIMEOUT_MS: z.coerce.number().int().positive().default(30000),
  // TLS 直连开关：不设时按端口推断（465=true，其余 false）；"true" 走 SSL 直连、"false" 走 587 STARTTLS/明文
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v.trim() === "true")),
  // 证书信任 *：默认校验证书（true），仅显式 "false" 时关闭校验证
  SMTP_TLS_REJECT_UNAUTHORIZED: z
    .string()
    .optional()
    .transform((v) => !(v !== undefined && v.trim() !== "" && v.trim().toLowerCase() === "false")),
  // .env 模板留空字符串时应视为未配置
  MAIL_HTTP_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  MAIL_HTTP_TOKEN: z.string().optional(),
  MAIL_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  APP_BASE_URL: z.string().url().default("http://localhost:3000"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // worker 进程（research.md）
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().min(100).default(5000),
  WORKER_LEASE_SECONDS: z.coerce.number().int().min(5).default(60),
  WORKER_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(50),
  SHUTDOWN_GRACE_MS: z.coerce.number().int().min(0).default(10000),

  // 通知中继（outbox）：并发/批量/超时/认领回收阈值，生产按水位调参无需重新部署
  // 邮件与 webhook 分离池：SMTP 慢不拖 webhook，反之亦然
  RELAY_EMAIL_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(5),
  RELAY_WEBHOOK_CONCURRENCY: z.coerce.number().int().min(1).max(32).default(5),
  RELAY_BATCH_SIZE: z.coerce.number().int().min(1).max(100).default(20),
  WEBHOOK_FETCH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(15000),
  OUTBOX_STALE_MS: z.coerce.number().int().min(60000).default(600000),
  // webhook 按域熔断：同 host 连续失败达阈值即熔断冷却，避免重试风暴
  RELAY_BREAKER_THRESHOLD: z.coerce.number().int().min(2).max(20).default(5),
  RELAY_BREAKER_COOLDOWN_MS: z.coerce.number().int().min(5000).max(600000).default(60000),
  // 同 host 最大并行：防单个慢下游占满全局池
  RELAY_PER_HOST_LIMIT: z.coerce.number().int().min(1).max(16).default(2),
  // 附件内联上限（字节）：relay 下载后直接贴进邮件；超限只嵌链接不下载；0=纯链接模式。
  // base64 膨胀约 37%：2MB 附件≈2.7MB 邮件，SES/postfix 10MB 上限下安全；硬顶 10MB。
  ATTACHMENT_INLINE_MAX_BYTES: z.coerce
    .number()
    .int()
    .min(0)
    .max(10 * 1024 * 1024)
    .default(2 * 1024 * 1024),

  // SSRF：允许访问内网 URL（RFC1918/loopback/linkLocal IP）。内网自用部署设 "true"；元数据地址等结构检查始终保留。
  SSRF_ALLOW_PRIVATE: z
    .enum(["true", "false"])
    .default("false")
    .transform((v) => v === "true")
    .pipe(z.boolean()),
  // 额外放行 "localhost" 主机名（配合 SSRF_ALLOW_PRIVATE；内网本机服务/自收 webhook 用）。默认 false。
  SSRF_ALLOW_LOCALHOST: z
    .string()
    .optional()
    .transform((v) => v !== undefined && v.trim() !== "" && v.trim().toLowerCase() === "true"),
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace"]).default("info"),

  // 节假日 API（可选；不配则 skipHolidays 任务在创建/更新时 400）。
  // URL 不含 appKey（key 单独配，避免进日志）；natural_day 按任务时区墙钟日期。
  HOLIDAY_API_URL: z.preprocess(
    (v) => (typeof v === "string" && v.trim() === "" ? undefined : v),
    z.string().url().optional(),
  ),
  HOLIDAY_API_APP_KEY: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v)),
  HOLIDAY_API_TIMEOUT_MS: z.coerce.number().int().min(1000).max(30000).default(5000),

  // 任务执行请求签名（对接 sqleditor execute-callback 用）：与对方约定的共享密钥。
  // 可选；不配则回退到各任务自生成的密钥（对方需升级成按任务验签才能用，否则配了才通）。
  // 空字符串视为未配置。
  TASK_CALLBACK_SIGN_SECRET: z
    .string()
    .optional()
    .transform((v) => (v === undefined || v.trim() === "" ? undefined : v)),
});

const parsed = EnvSchema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error("[config] 环境变量校验失败：", parsed.error.flatten().fieldErrors);
  throw new Error(`环境变量校验失败: ${parsed.error.message}`);
}

export const config = {
  ...parsed.data,
  /** AES-256-GCM 原始密钥（32 字节 Buffer） */
  payloadEncryptionKey: Buffer.from(parsed.data.PAYLOAD_ENCRYPTION_KEY, "hex"),
};

export type Config = typeof config;
