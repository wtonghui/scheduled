import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import type { Prisma } from "@prisma/client";

/**
 * Task 仓储：全部查询强制 `tenant_id` 过滤（FR-015 多租户隔离）。
 * 跨租户访问统一表现为 404（不泄露存在性）。
 */

const TASK_SELECT = {
  id: true,
  name: true,
  cron: true,
  scheduleIntervalSeconds: true,
  runAt: true,
  timezone: true,
  retryDelayMs: true,
  overlapPolicy: true,
  endsAt: true,
  maxRuns: true,
  taskType: true,
  payload: true,
  payloadSecrets: true,
  webhookUrl: true,
  emailSubjectTemplate: true,
  emailBodyTemplate: true,
  emailAttachmentUrlTemplate: true,
  enabled: true,
  maxAttempts: true,
  timeoutMs: true,
  recipients: true,
  notifyOn: true,
  version: true,
  systemUserId: true,
  nextRunAt: true,
  ownerTokenId: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.TaskSelect;

export type TaskProjection = Prisma.TaskGetPayload<{ select: typeof TASK_SELECT }>;

/**
 * 跨租户只读视图投影：额外含 tenantId，用于 service 计算 `writable` 标记。
 * tenantId 不会出现在 API 响应中（service 仅据此推导 writable 布尔）。
 */
const ALL_TASK_SELECT = { ...TASK_SELECT, tenantId: true } satisfies Prisma.TaskSelect;
export type AllTaskProjection = Prisma.TaskGetPayload<{ select: typeof ALL_TASK_SELECT }>;

export interface TaskListFilters {
  page: number;
  pageSize: number;
  enabled?: boolean;
  taskType?: string;
  q?: string;
  /** 仅显示指定 owner token 创建的任务（租户内按 token 隔离视图）。 */
  ownerTokenId?: string;
  /** 按系统内用户筛选任务（外部接入系统具体用户）。 */
  systemUserId?: string;
}

function whereFor(tenantId: string, filters: TaskListFilters): Prisma.TaskWhereInput {
  return {
    tenantId,
    ...(filters.enabled !== undefined ? { enabled: filters.enabled } : {}),
    ...(filters.taskType
      ? { taskType: filters.taskType as Prisma.TaskWhereInput["taskType"] }
      : {}),
    ...(filters.q ? { name: { contains: filters.q } } : {}),
    ...(filters.ownerTokenId ? { ownerTokenId: filters.ownerTokenId } : {}),
    ...(filters.systemUserId ? { systemUserId: filters.systemUserId } : {}),
  };
}

export async function listTasks(tenantId: string, filters: TaskListFilters) {
  const where = whereFor(tenantId, filters);
  // 只读列表不走 $transaction：读路径无一致快照需求，且事务要等池配额（maxWait 2s），
  // 冷启动/瞬时池占满时会报 P2028（Unable to start a transaction）。并行直查即可。
  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      select: TASK_SELECT,
      orderBy: [{ createdAt: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.task.count({ where }),
  ]);
  return { rows, total };
}

/**
 * 跨租户只读列表（受信网络匿名浏览场景）。无 tenant_id 过滤。
 * 含 tenantId 供 service 推导 writable；不直接外泄。
 */
export async function listAllTasks(filters: TaskListFilters) {
  const where: Prisma.TaskWhereInput = {
    ...(filters.enabled !== undefined ? { enabled: filters.enabled } : {}),
    ...(filters.taskType
      ? { taskType: filters.taskType as Prisma.TaskWhereInput["taskType"] }
      : {}),
    ...(filters.q ? { name: { contains: filters.q } } : {}),
    ...(filters.ownerTokenId ? { ownerTokenId: filters.ownerTokenId } : {}),
    ...(filters.systemUserId ? { systemUserId: filters.systemUserId } : {}),
  };
  // 同上：只读列表不走 $transaction，避免 P2028 事务启动超时。
  const [rows, total] = await Promise.all([
    prisma.task.findMany({
      where,
      select: ALL_TASK_SELECT,
      orderBy: [{ createdAt: "desc" }],
      skip: (filters.page - 1) * filters.pageSize,
      take: filters.pageSize,
    }),
    prisma.task.count({ where }),
  ]);
  return { rows, total };
}

/**
 * 跨租户只读单查（匿名/跨租户详情）。无 tenant_id 过滤。
 */
export async function getTaskById(id: string): Promise<AllTaskProjection | null> {
  return prisma.task.findUnique({
    where: { id },
    select: ALL_TASK_SELECT,
  });
}

export async function getTaskByTenant(
  tenantId: string,
  id: string,
): Promise<TaskProjection | null> {
  return prisma.task.findFirst({
    where: { id, tenantId },
    select: TASK_SELECT,
  });
}

export async function createTask(
  tenantId: string,
  ownerTokenId: string,
  data: Omit<Prisma.TaskCreateInput, "tenant" | "ownerToken">,
) {
  return prisma.task.create({
    data: {
      ...data,
      tenant: { connect: { id: tenantId } },
      ownerToken: { connect: { id: ownerTokenId } },
    },
    select: TASK_SELECT,
  });
}

/** 乐观并发：版本不匹配 → 409 VERSION_CONFLICT；跨租户/不存在 → 404。 */
export async function updateTaskWithVersion(
  tenantId: string,
  id: string,
  data: Prisma.TaskUpdateInput,
  expectedVersion: number,
): Promise<TaskProjection | null> {
  const result = await prisma.task.updateMany({
    where: { id, tenantId, version: expectedVersion },
    data: {
      ...data,
      version: { increment: 1 },
    },
  });
  if (result.count === 0) {
    const exists = await prisma.task.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!exists) {
      throw new AppError(404, "NOT_FOUND", "task not found");
    }
    throw new AppError(409, "VERSION_CONFLICT", "task was modified concurrently");
  }
  return prisma.task.findFirst({ where: { id, tenantId }, select: TASK_SELECT });
}

export async function deleteTaskByTenant(tenantId: string, id: string): Promise<boolean> {
  const result = await prisma.task.deleteMany({ where: { id, tenantId } });
  return result.count > 0;
}

/** worker 使用：按领取资格拉取到期无租约任务（禁用于请求路径）。 */
export async function findDueTasks(now: Date, batchSize: number): Promise<Array<{ id: string }>> {
  return prisma.task.findMany({
    where: {
      enabled: true,
      nextRunAt: { lte: now },
      OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
    },
    orderBy: { nextRunAt: "asc" },
    take: batchSize,
    select: { id: true },
  });
}
