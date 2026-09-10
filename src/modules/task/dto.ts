import { isValidCron, isValidTimezone } from "@/lib/cron";
import { AppError } from "@/lib/errors";
import { z } from "zod";

/**
 * Task 输入 DTO（contracts/api.md §2，data-model.md 校验规则）。
 * payload 按 taskType 分支校验；SSRF 异步校验在 service 层完成。
 */

export const TaskTypeSchema = z.enum(["http", "noop"]);

/** http 负载：url/method/params/headers/body（敏感字段 params/headers/body 入 payload_secrets 加密）。 */
export const HttpPayloadSchema = z.object({
  url: z.string().url("payload.url must be a valid URL"),
  method: z
    .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"], {
      error: "payload.method must be a standard HTTP method",
    })
    .default("GET"),
  /** URL query 参数（键值对；执行时并入 url 的 ?…，已存在的同名键会被覆盖）。 */
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.union([z.string(), z.null()]).optional(),
});
export type HttpPayload = z.infer<typeof HttpPayloadSchema>;

export const NotifyOnSchema = z.enum(["succeeded", "failed"]);

/** 一次性时刻：ISO 8601（允许 `Z` 或 `+08:00` 偏移，绝对时刻），必须在未来。 */
export const RunAtSchema = z
  .string()
  .trim()
  .datetime({ offset: true, message: "runAt must be an ISO 8601 datetime" })
  .refine((v) => new Date(v).getTime() > Date.now(), {
    message: "runAt must be in the future",
  });

/** IANA 时区：仅 cron 调度有意义（挂钟解析用）。 */
export const TimezoneSchema = z
  .string()
  .trim()
  .min(1, "timezone is required")
  .max(64, "timezone too long")
  .refine((v) => isValidTimezone(v), { message: "unknown IANA timezone" });

/** 重试等待基线（毫秒）：同次调度内 attempt 间隔的抖动上限基数；0=失败即重试。 */
export const RetryDelayMsSchema = z.number().int().min(0).max(3_600_000);

/** 重叠策略：上次执行未结束又到下次时刻时跳过 / 排队 / 允许并行（默认跳过=今天行为）。 */
export const OverlapPolicySchema = z.enum(["skip", "queue", "run"]);

/** 截止时刻：ISO 8601 绝对时刻，必须在未来；仅重复调度可配。 */
export const EndsAtSchema = z
  .string()
  .trim()
  .datetime({ offset: true, message: "endsAt must be an ISO 8601 datetime" })
  .refine((v) => new Date(v).getTime() > Date.now(), {
    message: "endsAt must be in the future",
  });

/** 总次数上限：≥1，仅重复调度可配（调度触发计，run-now/重试/跳过不计）。 */
export const MaxRunsSchema = z.number().int().min(1).max(1_000_000);

/** 调度三选一：cron / 固定间隔 / 一次性时刻，恰好一个非空。 */
export function isValidScheduleTriple(input: {
  cron?: string | null;
  scheduleIntervalSeconds?: number | null;
  runAt?: string | null;
}): boolean {
  const hasCron = typeof input.cron === "string" && input.cron.length > 0;
  const hasInterval =
    typeof input.scheduleIntervalSeconds === "number" &&
    Number.isInteger(input.scheduleIntervalSeconds) &&
    (input.scheduleIntervalSeconds as number) > 0;
  const hasRunAt = typeof input.runAt === "string" && input.runAt.length > 0;
  return [hasCron, hasInterval, hasRunAt].filter(Boolean).length === 1;
}

export const CreateTaskSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(191, "name too long"),
    cron: z.string().trim().optional(),
    scheduleIntervalSeconds: z.number().int().min(1).optional(),
    runAt: RunAtSchema.optional(),
    timezone: TimezoneSchema.optional(),
    retryDelayMs: RetryDelayMsSchema.optional(),
    overlapPolicy: OverlapPolicySchema.default("skip"),
    endsAt: EndsAtSchema.optional(),
    maxRuns: MaxRunsSchema.optional(),
    taskType: TaskTypeSchema.default("http"),
    payload: z.unknown(),
    enabled: z.boolean().default(true),
    maxAttempts: z.number().int().min(1).max(10).default(3),
    timeoutMs: z.number().int().min(1000).max(3_600_000).default(30_000),
    recipients: z
      .array(z.string().email("invalid recipient email"))
      .min(1, "at least one recipient"),
    notifyOn: z.array(NotifyOnSchema).default(["succeeded", "failed"]),
    webhookUrl: z.string().url().optional(),
    emailSubjectTemplate: z.string().trim().max(255).optional(),
    emailBodyTemplate: z.string().trim().max(10_000).optional(),
    emailAttachmentUrlTemplate: z.string().trim().max(512).optional(),
    systemUserId: z.string().trim().max(191).optional(),
  })
  .refine(
    (d) =>
      isValidScheduleTriple({
        cron: d.cron,
        scheduleIntervalSeconds: d.scheduleIntervalSeconds,
        runAt: d.runAt,
      }),
    { message: "exactly one of cron, scheduleIntervalSeconds or runAt is required" },
  )
  .refine((d) => (d.cron ? isValidCron(d.cron) : true), {
    message: "invalid cron expression",
  })
  .refine((d) => !(d.timezone && !d.cron && !d.runAt), {
    message: "timezone is only meaningful with cron or runAt (fixed intervals carry no wall-clock)",
  })
  .refine((d) => !(d.runAt && (d.endsAt || d.maxRuns || d.overlapPolicy !== "skip")), {
    message: "run-once tasks take no end rules or overlap policy (exactly one run)",
  });

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/** PATCH：可更新字段子集 + version（乐观并发必填）。 */
export const UpdateTaskSchema = z
  .object({
    name: z.string().trim().min(1).max(191).optional(),
    cron: z.string().trim().nullable().optional(),
    scheduleIntervalSeconds: z.number().int().min(1).nullable().optional(),
    runAt: RunAtSchema.nullable().optional(),
    timezone: TimezoneSchema.nullable().optional(),
    retryDelayMs: RetryDelayMsSchema.nullable().optional(),
    overlapPolicy: OverlapPolicySchema.optional(),
    endsAt: EndsAtSchema.nullable().optional(),
    maxRuns: MaxRunsSchema.nullable().optional(),
    taskType: TaskTypeSchema.optional(),
    payload: z.unknown().optional(),
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    recipients: z.array(z.string().email("invalid recipient email")).min(1).optional(),
    notifyOn: z.array(NotifyOnSchema).optional(),
    webhookUrl: z.string().url().nullable().optional(),
    emailSubjectTemplate: z.string().trim().max(255).nullable().optional(),
    emailBodyTemplate: z.string().trim().max(10_000).nullable().optional(),
    emailAttachmentUrlTemplate: z.string().trim().max(512).nullable().optional(),
    systemUserId: z.string().trim().max(191).nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine(
    (d) =>
      "cron" in d || "scheduleIntervalSeconds" in d || "runAt" in d
        ? isValidScheduleTriple({
            cron: d.cron ?? null,
            scheduleIntervalSeconds: d.scheduleIntervalSeconds ?? null,
            runAt: d.runAt ?? null,
          })
        : true,
    { message: "exactly one of cron, scheduleIntervalSeconds or runAt is required" },
  )
  .refine((d) => (d.cron ? isValidCron(d.cron) : true), {
    message: "invalid cron expression",
  })
  .refine(
    (d) => {
      if (!d.timezone) {
        return true;
      }
      const hasCron = "cron" in d && !!d.cron;
      const hasInterval = "scheduleIntervalSeconds" in d && !!d.scheduleIntervalSeconds;
      const hasRunAt = "runAt" in d && !!d.runAt;
      // 同包携带 interval 调度 → 直接拒绝（间隔无钟表概念）；
      // cron 和 runAt 均可配时区（runAt 的墙钟时刻需时区解释偏移）
      if (!hasCron && !hasRunAt && hasInterval) {
        return false;
      }
      return true;
    },
    {
      message:
        "timezone is only meaningful with cron or runAt (fixed intervals carry no wall-clock)",
    },
  )
  .refine(
    (d) => {
      // 同包携带 runAt + 结束规则/重叠策略 → 直接拒绝；单独出现由 service 按既有调度校验
      const hasRunAt = "runAt" in d && !!d.runAt;
      if (!hasRunAt) {
        return true;
      }
      const hasEndsAt = "endsAt" in d && !!d.endsAt;
      const hasMaxRuns = "maxRuns" in d && !!d.maxRuns;
      const hasOverlap = "overlapPolicy" in d && !!d.overlapPolicy;
      return !(hasEndsAt || hasMaxRuns || hasOverlap);
    },
    {
      message: "run-once tasks take no end rules or overlap policy (exactly one run)",
    },
  );

export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;

/** 校验 payload 与 taskType 匹配（I/O 边界 fail-fast）。 */
export function validatePayloadForType(
  taskType: "http" | "noop",
  payload: unknown,
): HttpPayload | null {
  if (taskType === "noop") {
    if (
      payload === undefined ||
      payload === null ||
      (typeof payload === "object" && Object.keys(payload as object).length === 0)
    ) {
      return null;
    }
    throw new AppError(400, "VALIDATION", "noop task must not carry a payload");
  }
  const parsed = HttpPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new AppError(400, "VALIDATION", "payload does not match taskType=http", [
      parsed.error.message,
    ]);
  }
  return parsed.data;
}
