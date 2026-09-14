import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import type { Prisma } from "@prisma/client";

/**
 * 通知查询（US4 / contracts §9 + W1）：严格按 tenant_id 隔离。
 */

const EMAIL_SELECT = {
  id: true,
  runId: true,
  taskId: true,
  toAddress: true,
  subject: true,
  html: true,
  text: true,
  status: true,
  attempts: true,
  messageId: true,
  sentAt: true,
  lastError: true,
  attachmentUrl: true,
  systemUserId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.EmailLogSelect;

const WEBHOOK_SELECT = {
  id: true,
  runId: true,
  webhookUrl: true,
  status: true,
  attempts: true,
  signature: true,
  responseCode: true,
  sentAt: true,
  lastError: true,
  createdAt: true,
} satisfies Prisma.WebhookDeliverySelect;

export async function listEmailLog(
  tenantId: string,
  page: number,
  pageSize: number,
  runId?: string,
  status?: string,
  systemUserId?: string,
) {
  const where: Prisma.EmailLogWhereInput = {
    tenantId,
    ...(runId ? { runId } : {}),
    ...(status ? { status: status as Prisma.EmailLogWhereInput["status"] } : {}),
    ...(systemUserId ? { systemUserId } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.emailLog.findMany({
      where,
      select: EMAIL_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.emailLog.count({ where }),
  ]);
  return { rows, total };
}

export async function listEmailLogByTask(
  tenantId: string,
  taskId: string,
  page: number,
  pageSize: number,
  status?: string,
  systemUserId?: string,
) {
  const task = await prisma.task.findFirst({
    where: { id: taskId, tenantId },
    select: { id: true },
  });
  if (!task) {
    return { rows: [], total: 0 };
  }
  const where: Prisma.EmailLogWhereInput = {
    tenantId,
    taskId,
    ...(status ? { status: status as Prisma.EmailLogWhereInput["status"] } : {}),
    ...(systemUserId ? { systemUserId } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.emailLog.findMany({
      where,
      select: EMAIL_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.emailLog.count({ where }),
  ]);
  return { rows, total };
}

export async function listWebhookDeliveries(
  tenantId: string,
  taskId: string,
  page: number,
  pageSize: number,
  systemUserId?: string,
) {
  // webhook_delivery 通过 run_id 关联 execution → task（跨租户 404）
  const task = await prisma.task.findFirst({
    where: { id: taskId, tenantId },
    select: { id: true },
  });
  if (!task) {
    return { rows: [], total: 0 };
  }
  const executions = await prisma.taskExecution.findMany({
    where: { taskId },
    select: { id: true },
  });
  const where: Prisma.WebhookDeliveryWhereInput = {
    tenantId,
    runId: { in: executions.map((e) => e.id) },
    ...(systemUserId ? { systemUserId } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.webhookDelivery.findMany({
      where,
      select: WEBHOOK_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.webhookDelivery.count({ where }),
  ]);
  return { rows, total };
}

/** outbox 主键（BigInt）解析：非法字符串 → 400，不走到 DB。 */
function parseOutboxId(raw: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new AppError(400, "VALIDATION", `invalid outbox id: ${raw}`);
  }
  return BigInt(raw);
}

const REDRIVE_EMAIL_SELECT = {
  id: true,
  runId: true,
  taskId: true,
  status: true,
  attempts: true,
  nextRetryAt: true,
  updatedAt: true,
} satisfies Prisma.EmailLogSelect;

const REDRIVE_WEBHOOK_SELECT = {
  id: true,
  runId: true,
  status: true,
  attempts: true,
  nextRetryAt: true,
  updatedAt: true,
} satisfies Prisma.WebhookDeliverySelect;

/**
 * 死信重投（P1-2）：dead → pending，attempts 归零（重给一轮机会），nextRetryAt 清空（立刻可领），
 * lastError 保留不断链。条件 UPDATE 保证原子：并发双点只有一个生效，另一个见 pending → 409。
 * 跨租户查不到一律 404（与查询接口同规矩）。
 */
export async function redriveEmail(idRaw: string, tenantId: string, tokenId: string) {
  const id = parseOutboxId(idRaw);
  const updated = await prisma.emailLog.updateMany({
    where: { id, tenantId, status: "dead" },
    data: { status: "pending", attempts: 0, nextRetryAt: null },
  });
  if (updated.count === 0) {
    const existing = await prisma.emailLog.findFirst({
      where: { id, tenantId },
      select: { status: true },
    });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "email log not found");
    }
    throw new AppError(409, "NOT_DEAD", `only dead rows can be redriven (status=${existing.status})`);
  }
  logger.warn({ tenantId, tokenId, emailLogId: id.toString() }, "email redriven from dead to pending");
  return prisma.emailLog.findUniqueOrThrow({ where: { id }, select: REDRIVE_EMAIL_SELECT });
}

/** 同 redriveEmail，对象为 webhook_delivery。 */
export async function redriveWebhook(idRaw: string, tenantId: string, tokenId: string) {
  const id = parseOutboxId(idRaw);
  const updated = await prisma.webhookDelivery.updateMany({
    where: { id, tenantId, status: "dead" },
    data: { status: "pending", attempts: 0, nextRetryAt: null },
  });
  if (updated.count === 0) {
    const existing = await prisma.webhookDelivery.findFirst({
      where: { id, tenantId },
      select: { status: true },
    });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "webhook delivery not found");
    }
    throw new AppError(409, "NOT_DEAD", `only dead rows can be redriven (status=${existing.status})`);
  }
  logger.warn(
    { tenantId, tokenId, webhookDeliveryId: id.toString() },
    "webhook redriven from dead to pending",
  );
  return prisma.webhookDelivery.findUniqueOrThrow({ where: { id }, select: REDRIVE_WEBHOOK_SELECT });
}
