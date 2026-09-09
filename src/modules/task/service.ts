import { DEFAULT_TIMEZONE, computeNextRun } from "@/lib/cron";
import { decryptJson, encryptJson, encryptSecret, generateWebhookSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { checkUrlForSsrf } from "@/lib/ssrf";
import type { Prisma } from "@prisma/client";
import {
  CreateTaskSchema,
  type HttpPayload,
  UpdateTaskSchema,
  validatePayloadForType,
} from "./dto";
import {
  deleteTaskByTenant,
  getTaskById,
  getTaskByTenant,
  listAllTasks,
  listTasks,
  createTask as repoCreate,
  updateTaskWithVersion,
} from "./repository";

/**
 * Task 服务：DTO 校验 → SSRF → 敏感字段加密 → 落库。
 * payload 拆分为非敏感 `payload`（url/method）+ 加密 `payloadSecrets`（headers/body）。
 */

type TaskRow = Prisma.TaskGetPayload<{
  select: {
    id: true;
    name: true;
    cron: true;
    scheduleIntervalSeconds: true;
    runAt: true;
    timezone: true;
    retryDelayMs: true;
    overlapPolicy: true;
    endsAt: true;
    maxRuns: true;
    taskType: true;
    payload: true;
    payloadSecrets: true;
    webhookUrl: true;
    enabled: true;
    maxAttempts: true;
    timeoutMs: true;
    recipients: true;
    notifyOn: true;
    version: true;
    nextRunAt: true;
    createdAt: true;
    updatedAt: true;
  };
}>;

export interface TaskView {
  id: string;
  name: string;
  cron: string | null;
  scheduleIntervalSeconds: number | null;
  /** 一次性时刻；与 cron/interval 三选一，执行后自动停用 */
  runAt: Date | null;
  /** cron 解析用 IANA 时区（非 cron 调度恒为默认时区） */
  timezone: string;
  /** 同次调度内重试等待基线（毫秒）；null=默认退避（1s 起×2/30s 封顶） */
  retryDelayMs: number | null;
  /** 重叠策略：skip 跳过 / queue 排队 / run 允许并行（默认 skip） */
  overlapPolicy: string;
  /** 重复调度截止时刻；与 maxRuns 可共存（谁先到谁停） */
  endsAt: Date | null;
  /** 重复调度总次数上限（调度触发计，run-now/重试/跳过不计） */
  maxRuns: number | null;
  taskType: "http" | "noop";
  payload: Record<string, unknown>;
  enabled: boolean;
  maxAttempts: number;
  timeoutMs: number;
  recipients: string[];
  notifyOn: string[];
  webhookUrl: string | null;
  systemUserId?: string | null;
  nextRunAt: Date | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  /**
   * 该任务对当前查看者是否可写（= 属于查看者租户）。
   * 跨租户只读视图下为 false；匿名查看者全部为 false。
   * 仅作 UI 显隐用，写操作仍由 requireAuth + 租户隔离后端强制。
   */
  writable: boolean;
}

function splitPayload(
  taskType: "http" | "noop",
  httpPayload: HttpPayload | null,
): { publicPayload: Prisma.InputJsonValue; secretBytes: Buffer | null } {
  if (taskType === "noop") {
    return { publicPayload: {}, secretBytes: null };
  }
  // 已到 http 分支，payload 必然非空（调用前经 validatePayloadForType 保证）
  const { url, method } = httpPayload as HttpPayload;
  const secretObj: Record<string, unknown> = {};
  if (httpPayload?.params) {
    secretObj.params = httpPayload.params;
  }
  if (httpPayload?.headers) {
    secretObj.headers = httpPayload.headers;
  }
  if (httpPayload?.body !== undefined) {
    secretObj.body = httpPayload.body;
  }
  const secretBytes = Object.keys(secretObj).length > 0 ? encryptJson(secretObj) : null;
  return { publicPayload: { url, method }, secretBytes };
}

function toView(row: TaskRow): TaskView {
  let payload = row.payload as Record<string, unknown>;
  if (row.payloadSecrets) {
    const secrets = decryptJson(row.payloadSecrets) as Record<string, unknown>;
    payload = { ...payload, ...secrets };
  }
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    scheduleIntervalSeconds: row.scheduleIntervalSeconds,
    runAt: row.runAt,
    timezone: row.timezone,
    retryDelayMs: row.retryDelayMs,
    overlapPolicy: row.overlapPolicy,
    endsAt: row.endsAt,
    maxRuns: row.maxRuns,
    taskType: row.taskType,
    payload,
    enabled: row.enabled,
    maxAttempts: row.maxAttempts,
    timeoutMs: row.timeoutMs,
    recipients: row.recipients as string[],
    notifyOn: row.notifyOn as string[],
    webhookUrl: row.webhookUrl,
    systemUserId: (row as any).systemUserId ?? null,
    nextRunAt: row.nextRunAt,
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    // toView 仅用于租户隔离查询路径（list/get/create/update），均为调用方本租户 → 可写
    writable: true,
  };
}

/**
 * 跨租户只读视图：按 viewerTenantId 推导 writable。
 * viewerTenantId 为 null（匿名）→ 全部 false。
 */
function toViewAll(row: TaskRow & { tenantId: string }, viewerTenantId: string | null): TaskView {
  const view = toView(row);
  return { ...view, writable: viewerTenantId !== null && row.tenantId === viewerTenantId };
}

export interface TaskListQuery {
  page?: number;
  pageSize?: number;
  enabled?: boolean;
  taskType?: string;
  q?: string;
  /** 仅显示该 owner token 创建的任务（租户内按 token 隔离视图）。 */
  ownerTokenId?: string;
  /** 按系统内用户筛选任务（外部接入系统具体用户）。 */
  systemUserId?: string;
}

export async function list(tenantId: string, query: TaskListQuery) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const { rows, total } = await listTasks(tenantId, {
    page,
    pageSize,
    enabled: query.enabled,
    taskType: query.taskType,
    q: query.q,
    ownerTokenId: query.ownerTokenId,
    systemUserId: query.systemUserId,
  });
  return {
    data: rows.map(toView),
    meta: { page, pageSize, total },
  };
}

/**
 * 跨租户只读列表（受信网络全量浏览）。不带 tenant 过滤。
 * viewerTenantId 非空 → 据此为每行标注 writable（本租户=true）。
 * viewerTenantId 为 null（匿名）→ 全部 writable=false。
 */
export async function listAll(viewerTenantId: string | null, query: TaskListQuery) {
  const page = Math.max(1, query.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
  const { rows, total } = await listAllTasks({
    page,
    pageSize,
    enabled: query.enabled,
    taskType: query.taskType,
    q: query.q,
    ownerTokenId: query.ownerTokenId,
    systemUserId: query.systemUserId,
  });
  return {
    data: rows.map((row) => toViewAll(row, viewerTenantId)),
    meta: { page, pageSize, total },
  };
}

export async function get(tenantId: string, id: string): Promise<TaskView> {
  const row = await getTaskByTenant(tenantId, id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }
  return toView(row);
}

/**
 * 跨租户只读单查（匿名/跨租户详情）。不带 tenant 过滤。
 * viewerTenantId 用于推导 writable。
 */
export async function getAny(id: string, viewerTenantId: string | null): Promise<TaskView> {
  const row = await getTaskById(id);
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }
  return toViewAll(row, viewerTenantId);
}

export async function create(
  tenantId: string,
  ownerTokenId: string,
  input: unknown,
): Promise<TaskView> {
  const parsed = CreateTaskSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      400,
      "VALIDATION",
      "invalid task input",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const data = parsed.data;

  const httpPayload = validatePayloadForType(data.taskType, data.payload);
  if (data.taskType === "http" && httpPayload) {
    const ssrf = await checkUrlForSsrf(httpPayload.url);
    if (!ssrf.ok) {
      throw new AppError(400, "VALIDATION", `url blocked by SSRF policy: ${ssrf.reason}`);
    }
  }

  const { publicPayload, secretBytes } = splitPayload(data.taskType, httpPayload);
  const timezone = data.timezone ?? DEFAULT_TIMEZONE;
  const nextRunAt = data.runAt
    ? new Date(data.runAt)
    : computeNextRun(
        { cron: data.cron, scheduleIntervalSeconds: data.scheduleIntervalSeconds },
        new Date(),
        timezone,
      );
  if (!nextRunAt) {
    throw new AppError(400, "VALIDATION", "schedule yields no future run");
  }
  if (data.endsAt && new Date(data.endsAt).getTime() <= nextRunAt.getTime()) {
    throw new AppError(400, "VALIDATION", "endsAt is before the first scheduled run");
  }

  const row = await repoCreate(tenantId, ownerTokenId, {
    name: data.name,
    cron: data.cron ?? null,
    scheduleIntervalSeconds: data.scheduleIntervalSeconds ?? null,
    runAt: data.runAt ? new Date(data.runAt) : null,
    timezone,
    retryDelayMs: data.retryDelayMs ?? null,
    overlapPolicy: data.overlapPolicy,
    endsAt: data.endsAt ? new Date(data.endsAt) : null,
    maxRuns: data.maxRuns ?? null,
    taskType: data.taskType,
    payload: publicPayload,
    payloadSecrets: secretBytes ? new Uint8Array(secretBytes) : null,
    enabled: data.enabled,
    maxAttempts: data.maxAttempts,
    timeoutMs: data.timeoutMs,
    recipients: data.recipients as Prisma.InputJsonValue,
    notifyOn: data.notifyOn as Prisma.InputJsonValue,
    webhookUrl: data.webhookUrl ?? null,
    ...(data.systemUserId ? { systemUserId: data.systemUserId } : {}),
    webhookSecret: data.webhookUrl ? new Uint8Array(encryptSecret(generateWebhookSecret())) : null,
    nextRunAt,
  });
  return toView(row);
}

export async function update(tenantId: string, id: string, input: unknown): Promise<TaskView> {
  const parsed = UpdateTaskSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      400,
      "VALIDATION",
      "invalid task input",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const data = parsed.data;

  const existing = await getTaskByTenant(tenantId, id);
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }

  const effectiveType = (data.taskType ?? existing.taskType) as "http" | "noop";

  // payload / taskType 变更 → 重新拆分加密
  let payloadUpdate: Prisma.TaskUpdateInput["payload"] | undefined;
  let secretsUpdate: Uint8Array | null | undefined;
  if ("payload" in data || data.taskType) {
    const httpPayload = validatePayloadForType(
      effectiveType,
      "payload" in data ? data.payload : (existing.payload as Record<string, unknown>),
    );
    if (effectiveType === "http" && httpPayload) {
      const ssrf = await checkUrlForSsrf(httpPayload.url);
      if (!ssrf.ok) {
        throw new AppError(400, "VALIDATION", `url blocked by SSRF policy: ${ssrf.reason}`);
      }
    }
    const split = splitPayload(effectiveType, httpPayload);
    payloadUpdate = split.publicPayload;
    secretsUpdate = split.secretBytes;
  }

  // 重算 next_run_at（生效调度 = 传入覆盖既有；传入新调度会清掉其它调度字段，保持三选一）
  let nextRunAt: Date | null | undefined;
  const scheduleTouched = "cron" in data || "scheduleIntervalSeconds" in data || "runAt" in data;
  // 生效时区：仅 cron 调度有意义；切到 interval/runAt 时归位默认，避免过期值误导
  let timezoneToStore: string | undefined;
  if (scheduleTouched || "timezone" in data) {
    const effCron = data.cron !== undefined ? data.cron : existing.cron;
    const effInterval =
      data.scheduleIntervalSeconds !== undefined
        ? data.scheduleIntervalSeconds
        : existing.scheduleIntervalSeconds;
    const effRunAt =
      data.runAt !== undefined ? (data.runAt ? new Date(data.runAt) : null) : existing.runAt;
    const effKind = effRunAt ? "runAt" : effCron ? "cron" : effInterval ? "interval" : null;
    if (!effKind) {
      throw new AppError(
        400,
        "VALIDATION",
        "exactly one of cron, scheduleIntervalSeconds or runAt is required",
      );
    }
    if (
      data.timezone !== undefined &&
      data.timezone !== null &&
      effKind !== "cron" &&
      effKind !== "runAt"
    ) {
      throw new AppError(
        400,
        "VALIDATION",
        "timezone is only meaningful with cron or runAt (fixed intervals carry no wall-clock)",
      );
    }
    // 结束规则/重叠策略仅重复调度可配；单独出现时按既有调度校验（一次任务 → 400）
    const endRuleTouched = "endsAt" in data || "maxRuns" in data || "overlapPolicy" in data;
    if (endRuleTouched && effKind === "runAt") {
      throw new AppError(
        400,
        "VALIDATION",
        "run-once tasks take no end rules or overlap policy (exactly one run)",
      );
    }
    const effTimezone =
      data.timezone !== undefined ? (data.timezone ?? DEFAULT_TIMEZONE) : existing.timezone;
    timezoneToStore = effKind === "cron" || effKind === "runAt" ? effTimezone : DEFAULT_TIMEZONE;
    nextRunAt = effRunAt
      ? effRunAt
      : computeNextRun(
          {
            cron: (effCron ?? undefined) as string | undefined,
            scheduleIntervalSeconds: (effInterval ?? undefined) as number | undefined,
          },
          new Date(),
          effTimezone,
        );
  }
  if (data.enabled === false) {
    nextRunAt = null;
  } else if (data.enabled === true && existing.enabled === false) {
    // 重启用：按既有调度（含一次性时刻与时区）重算；已过的一次性时刻由 worker 到期即领
    nextRunAt = existing.runAt
      ? existing.runAt
      : computeNextRun(
          {
            cron: (existing.cron ?? undefined) as string | undefined,
            scheduleIntervalSeconds: (existing.scheduleIntervalSeconds ?? undefined) as
              | number
              | undefined,
          },
          new Date(),
          existing.timezone,
        );
  }

  const row = await updateTaskWithVersion(
    tenantId,
    id,
    {
      ...(data.name !== undefined && { name: data.name }),
      // 调度字段必须随更新落库，否则只重算 next_run_at、cron 列不变（编辑 cron 不生效）；
      // 传入新调度会清掉其它调度字段（DTO 已保证三选一），防止 cron/interval/runAt 并存
      ...(data.cron !== undefined && {
        cron: data.cron,
        ...(typeof data.cron === "string" ? { scheduleIntervalSeconds: null, runAt: null } : {}),
      }),
      ...(data.scheduleIntervalSeconds !== undefined && {
        scheduleIntervalSeconds: data.scheduleIntervalSeconds,
        ...(typeof data.scheduleIntervalSeconds === "number" ? { cron: null, runAt: null } : {}),
      }),
      ...(data.runAt !== undefined && {
        runAt: data.runAt ? new Date(data.runAt) : null,
        ...(typeof data.runAt === "string" ? { cron: null, scheduleIntervalSeconds: null } : {}),
      }),
      ...(timezoneToStore !== undefined && { timezone: timezoneToStore }),
      ...(data.retryDelayMs !== undefined && { retryDelayMs: data.retryDelayMs }),
      ...(data.overlapPolicy !== undefined && { overlapPolicy: data.overlapPolicy }),
      ...(data.endsAt !== undefined && {
        endsAt: data.endsAt ? new Date(data.endsAt) : null,
      }),
      ...(data.maxRuns !== undefined && { maxRuns: data.maxRuns }),
      ...(data.taskType !== undefined && { taskType: data.taskType }),
      ...(payloadUpdate !== undefined && { payload: payloadUpdate }),
      ...(secretsUpdate !== undefined && {
        payloadSecrets: secretsUpdate ? new Uint8Array(secretsUpdate) : null,
      }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      ...(data.maxAttempts !== undefined && { maxAttempts: data.maxAttempts }),
      ...(data.timeoutMs !== undefined && { timeoutMs: data.timeoutMs }),
      ...(data.recipients !== undefined && {
        recipients: data.recipients as Prisma.InputJsonValue,
      }),
      ...(data.notifyOn !== undefined && { notifyOn: data.notifyOn as Prisma.InputJsonValue }),
      ...(data.webhookUrl !== undefined && {
        webhookUrl: data.webhookUrl,
        webhookSecret: data.webhookUrl
          ? new Uint8Array(encryptSecret(generateWebhookSecret()))
          : null,
      }),
      ...(data.systemUserId !== undefined && {
        systemUserId: data.systemUserId || null,
      }),
      ...(nextRunAt !== undefined && { nextRunAt }),
    },
    data.version,
  );
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }
  return toView(row);
}

export async function remove(tenantId: string, id: string): Promise<void> {
  // 硬删除（v1）：同一事务内先清 outbox/执行，避免 FK（run_id→execution、task_id）冲突
  const result = await prisma.$transaction(async (tx) => {
    const executions = await tx.taskExecution.findMany({
      where: { taskId: id },
      select: { id: true },
    });
    // 先清 outbox（FK: run_id → execution），再删 task（onDelete: Cascade 级联 executions）
    await tx.emailLog.deleteMany({ where: { runId: { in: executions.map((e) => e.id) } } });
    await tx.webhookDelivery.deleteMany({ where: { runId: { in: executions.map((e) => e.id) } } });
    return tx.task.deleteMany({ where: { id, tenantId } });
  });
  if (result.count === 0) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }
}

/** run-now：创建一次 manual 执行（绕过调度立即入队）。 */
export async function runTaskNow(tenantId: string, taskId: string) {
  const task = await getTaskByTenant(tenantId, taskId);
  if (!task) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }
  const now = new Date();
  const idempotencyKey = `${taskId}:${now.toISOString()}`;
  try {
    const execution = await prisma.taskExecution.create({
      data: {
        taskId,
        idempotencyKey,
        scheduledAt: now,
        attempt: 1,
        trigger: "manual",
        status: "pending",
      },
    });
    return execution;
  } catch (error) {
    // 同一毫秒重复触发 → 幂等返回既有执行
    if ((error as { code?: string }).code === "P2002") {
      const existing = await prisma.taskExecution.findUnique({
        where: { idempotencyKey },
      });
      if (existing) {
        return existing;
      }
    }
    throw error;
  }
}
