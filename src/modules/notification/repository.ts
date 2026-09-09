import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * 通知查询（US4 / contracts §9 + W1）：严格按 tenant_id 隔离。
 */

const EMAIL_SELECT = {
  id: true,
  runId: true,
  toAddress: true,
  subject: true,
  status: true,
  attempts: true,
  messageId: true,
  sentAt: true,
  lastError: true,
  createdAt: true,
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