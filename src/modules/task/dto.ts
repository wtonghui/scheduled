import { isValidCron, isValidSchedule } from "@/lib/cron";
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

export const CreateTaskSchema = z
  .object({
    name: z.string().trim().min(1, "name is required").max(191, "name too long"),
    cron: z.string().trim().optional(),
    scheduleIntervalSeconds: z.number().int().min(1).optional(),
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
  })
  .refine(
    (d) => isValidSchedule({ cron: d.cron, scheduleIntervalSeconds: d.scheduleIntervalSeconds }),
    { message: "exactly one of cron or scheduleIntervalSeconds is required" },
  )
  .refine((d) => (d.cron ? isValidCron(d.cron) : true), {
    message: "invalid cron expression",
  });

export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;

/** PATCH：可更新字段子集 + version（乐观并发必填）。 */
export const UpdateTaskSchema = z
  .object({
    name: z.string().trim().min(1).max(191).optional(),
    cron: z.string().trim().nullable().optional(),
    scheduleIntervalSeconds: z.number().int().min(1).nullable().optional(),
    taskType: TaskTypeSchema.optional(),
    payload: z.unknown().optional(),
    enabled: z.boolean().optional(),
    maxAttempts: z.number().int().min(1).max(10).optional(),
    timeoutMs: z.number().int().min(1000).max(3_600_000).optional(),
    recipients: z.array(z.string().email("invalid recipient email")).min(1).optional(),
    notifyOn: z.array(NotifyOnSchema).optional(),
    webhookUrl: z.string().url().nullable().optional(),
    version: z.number().int().min(1),
  })
  .refine(
    (d) =>
      "cron" in d || "scheduleIntervalSeconds" in d
        ? isValidSchedule({
            cron: d.cron ?? null,
            scheduleIntervalSeconds: d.scheduleIntervalSeconds ?? null,
          })
        : true,
    { message: "exactly one of cron or scheduleIntervalSeconds is required" },
  )
  .refine((d) => (d.cron ? isValidCron(d.cron) : true), {
    message: "invalid cron expression",
  });

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
