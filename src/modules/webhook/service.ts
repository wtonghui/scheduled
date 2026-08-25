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
    ...(input.error !== undefined ? { error: input.error } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
  } as Prisma.InputJsonValue;
}