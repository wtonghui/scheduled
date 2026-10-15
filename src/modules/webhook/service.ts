import type { Prisma } from "@prisma/client";

/**
 * Webhook 回调负载/验签编排。
 */

export interface RunResultPayload {
  runId: string;
  taskId: string;
  taskName: string;
  status: string;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  /** 下次触发（北京时间 ISO；null=无后续运行，如一次性跑完或已停用） */
  nextRunAt: string | null;
  /** 停用原因（未停用=null）：manual / run_once_done / ends_at / max_runs / no_future_schedule / unknown */
  disabledReason: string | null;
  error?: unknown;
  result?: unknown;
}

export function buildWebhookPayload(input: RunResultPayload): Prisma.InputJsonValue {
  return {
    runId: input.runId,
    taskId: input.taskId,
    taskName: input.taskName,
    status: input.status,
    scheduledAt: input.scheduledAt,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    durationMs: input.durationMs,
    nextRunAt: input.nextRunAt,
    disabledReason: input.disabledReason,
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
  } as Prisma.InputJsonValue;
}