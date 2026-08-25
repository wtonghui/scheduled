import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";

/**
 * 执行记录查询（US4 可观测性）：严格按 tenant_id 隔离。
 */

const EXECUTION_SELECT = {
  id: true,
  taskId: true,
  scheduledAt: true,
  startedAt: true,
  finishedAt: true,
  status: true,
  attempt: true,
  durationMs: true,
  error: true,
  trigger: true,
  createdAt: true,
} satisfies Prisma.TaskExecutionSelect;

export async function listByTask(tenantId: string, taskId: string, page: number, pageSize: number) {
  const where = { taskId, task: { tenantId } } satisfies Prisma.TaskExecutionWhereInput;
  const [rows, total] = await prisma.$transaction([
    prisma.taskExecution.findMany({
      where,
      select: EXECUTION_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.taskExecution.count({ where }),
  ]);
  return { rows, total };
}

/**
 * 跨租户只读：按 taskId 查执行历史（匿名浏览）。无 tenant 过滤。
 */
export async function listByTaskAny(taskId: string, page: number, pageSize: number) {
  const where = { taskId } satisfies Prisma.TaskExecutionWhereInput;
  const [rows, total] = await prisma.$transaction([
    prisma.taskExecution.findMany({
      where,
      select: EXECUTION_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.taskExecution.count({ where }),
  ]);
  return { rows, total };
}

export async function listAll(
  tenantId: string,
  page: number,
  pageSize: number,
  taskId?: string,
  status?: string,
) {
  const where: Prisma.TaskExecutionWhereInput = {
    task: { tenantId },
    ...(taskId ? { taskId } : {}),
    ...(status ? { status: status as Prisma.TaskExecutionWhereInput["status"] } : {}),
  };
  const [rows, total] = await prisma.$transaction([
    prisma.taskExecution.findMany({
      where,
      select: EXECUTION_SELECT,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
    prisma.taskExecution.count({ where }),
  ]);
  return { rows, total };
}