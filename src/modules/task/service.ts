import { DEFAULT_TIMEZONE, computeNextRun } from "@/lib/cron";
import { decryptJson, decryptSecret, encryptJson, encryptSecret, generateWebhookSecret } from "@/lib/crypto";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { adjustForHolidays, isHolidayConfigured, type HolidayPolicy } from "@/lib/holiday";
import { logger } from "@/lib/logger";
import { checkUrlForSsrf } from "@/lib/ssrf";
import type { Prisma } from "@prisma/client";
import {
  CreateTaskSchema,
  type HttpPayload,
  PreviewNextRunSchema,
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
    consumedRuns: true;
    claimedBy: true;
    claimedUntil: true;
    startsAt: true;
    skipHolidays: true;
    holidayPolicy: true;
    taskType: true;
    payload: true;
    payloadSecrets: true;
    webhookUrl: true;
    emailSubjectTemplate: true;
    emailBodyTemplate: true;
    emailSubjectTemplateFailed: true;
    emailBodyTemplateFailed: true;
    emailAttachmentUrlTemplate: true;
    enabled: true;
    disabledReason: true;
    disabledAt: true;
    disabledBy: true;
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
  /** 已消耗配额（调度触发计，与 maxRuns 配对看进度；归档不影响，永不复活） */
  consumedRuns: number;
  /** 当前领取该任务的 worker 实例 id；null=无租约（空闲） */
  claimedBy: string | null;
  /** 租约到期时间；过期可被重新领取/回收 */
  claimedUntil: Date | null;
  /** 重复调度的开始时刻；首跑从此起算，之后自然失效 */
  startsAt: Date | null;
  /** 到点遇假日是否跳过/顺延 */
  skipHolidays: boolean;
  /** drop 作废 / postpone 顺延到下一工作日同墙钟时刻 */
  holidayPolicy: string;
  taskType: "http" | "noop";
  payload: Record<string, unknown>;
  enabled: boolean;
  /** 停用原因（写时定夺）：manual 手动 / run_once_done 单次跑完 / ends_at 到截止 / max_runs 到次数 / no_future_schedule 无未来计划 / unknown 历史未知；启用中为 null */
  disabledReason: string | null;
  /** 停用时刻；启用中为 null */
  disabledAt: Date | null;
  /** 停用人：手动=操作 tokenId，自动=worker 实例 id；启用中为 null */
  disabledBy: string | null;
  maxAttempts: number;
  timeoutMs: number;
  recipients: string[];
  notifyOn: string[];
  webhookUrl: string | null;
  /** 邮件标题模板（{xxx} 占位，运行时从响应体替换）；null=沿用默认标题 */
  emailSubjectTemplate: string | null;
  /** 邮件正文模板（HTML，{xxx} 占位）；null=沿用默认 React Email 模板 */
  emailBodyTemplate: string | null;
  /** 失败专用标题模板；null=回退成功模板 */
  emailSubjectTemplateFailed: string | null;
  /** 失败专用正文模板；null=回退成功模板 */
  emailBodyTemplateFailed: string | null;
  /** 附件 URL 模板（{xxx} 占位）；null=无附件 */
  emailAttachmentUrlTemplate: string | null;
  systemUserId?: string | null;
  nextRunAt: Date | null;
  /**
   * 服务端测算的下一次运行（含节假日/起止/配额；interval 为估算）。
   * 仅单行接口（详情/创建/更新）填充，列表为 null；计算失败也为 null（前端回退 nextRunAt）。
   */
  upcoming: UpcomingInfo | null;
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

/**
 * 首跑时刻：startsAt 之前不触发。
 * cron → 从 max(now, startsAt) 起算第一个命中点；
 * interval → startsAt 在未来则首跑即 startsAt，否则 now+N（顺延）。
 * 预览接口复用同一函数（导出去），保证“预览的时间”和“实际跑的时间”同一口径。
 */
export function resolveFirstRun(
  schedule: { cron?: string | null; scheduleIntervalSeconds?: number | null },
  startsAt: Date | null,
  timezone: string,
  now: Date,
): Date | null {
  const ref = startsAt && startsAt.getTime() > now.getTime() ? startsAt : now;
  if (typeof schedule.scheduleIntervalSeconds === "number") {
    if (startsAt && startsAt.getTime() > now.getTime()) {
      return startsAt;
    }
    return new Date(now.getTime() + schedule.scheduleIntervalSeconds * 1000);
  }
  return computeNextRun(schedule, ref, timezone);
}

/** 单次预览行：计划时刻 + 是否被节假日调整过（drop 跳过中间 tick 只体现在时间差上）。 */
export interface UpcomingRun {
  scheduledAt: Date;
  holidayAdjusted: boolean;
}

/** 预览终止原因：endsAt=下一次已超截止；maxRuns=配额已用尽（读 consumedRuns）；no-future-schedule=调度本身无未来时间。还有后续则为 null（runs 非空时也可同时带 stopped，表示“这几 run 完即止”）。 */
export type UpcomingStopReason = "endsAt" | "maxRuns" | "no-future-schedule";

/** 详情 enrichment：scheduledAt 为 null 时看 stoppedReason；计算失败则整体为 null（前端回退存储值）。 */
export interface UpcomingInfo {
  scheduledAt: Date | null;
  holidayAdjusted: boolean;
  stoppedReason: UpcomingStopReason | null;
}

export interface UpcomingSpec {
  cron: string | null;
  scheduleIntervalSeconds: number | null;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRuns: number | null;
  consumedRuns: number;
  skipHolidays: boolean;
  holidayPolicy: string;
}

/**
 * 下次运行预览（纯函数，不碰库）：与 claim 同语义（resolveFirstRun 起算、节假日调整、
 * maxRuns/endsAt 终止），供详情 enrichment 与 preview-spec 接口共用。
 * overlap/maxAttempts/重试不考虑（执行层的事，不影响到点时刻）；interval 是估算
 * （假设在 cursor 时刻跑完，与 claim 从认领时刻起算同口径）。
 */
export async function computeUpcomingRuns(
  spec: UpcomingSpec,
  opts: {
    from?: Date;
    count?: number;
    /** 测试注入；默认走真实 isHoliday（含 24h 缓存）。 */
    isHolidayFn?: (naturalDay: string) => Promise<boolean | null>;
  } = {},
): Promise<{ runs: UpcomingRun[]; stopped: UpcomingStopReason | null }> {
  const count = Math.min(10, Math.max(1, Math.floor(opts.count ?? 1) || 1));
  const from = opts.from ?? new Date();
  const schedule = { cron: spec.cron, scheduleIntervalSeconds: spec.scheduleIntervalSeconds };
  const runs: UpcomingRun[] = [];
  let cursor = from;
  for (let i = 0; i < count; i += 1) {
    const raw = resolveFirstRun(schedule, spec.startsAt, spec.timezone, cursor);
    if (!raw) {
      return { runs, stopped: "no-future-schedule" };
    }
    const adjusted = spec.skipHolidays
      ? await adjustForHolidays({
          candidate: raw,
          policy: spec.holidayPolicy as HolidayPolicy,
          timezone: spec.timezone,
          nextAfter: (d) => computeNextRun(schedule, d, spec.timezone),
          ...(opts.isHolidayFn ? { isHolidayFn: opts.isHolidayFn } : {}),
        })
      : raw;
    if (!adjusted) {
      return { runs, stopped: "no-future-schedule" };
    }
    if (
      spec.maxRuns != null &&
      Number(spec.consumedRuns ?? 0) + runs.length >= Number(spec.maxRuns)
    ) {
      return { runs, stopped: "maxRuns" };
    }
    if (spec.endsAt && adjusted.getTime() > spec.endsAt.getTime()) {
      return { runs, stopped: "endsAt" };
    }
    runs.push({
      scheduledAt: adjusted,
      holidayAdjusted: adjusted.getTime() !== raw.getTime(),
    });
    cursor = adjusted;
  }
  return { runs, stopped: null };
}

/**
 * 未保存配置的预览（创建/编辑表单用）：cron / interval / runAt 三选一，与创建同口径；
 * skipHolidays 要求节假日 API 已配置（否则预览显示“无调整”会误导，与创建同规则）。
 * runAt 走单发分支（一条命，跑完即止恒为 stopped）；核心循环只做重复。
 */
export async function previewSpecNextRuns(
  input: unknown,
  opts: {
    /** 测试注入；默认走真实 isHoliday（含 24h 缓存）。 */
    isHolidayFn?: (naturalDay: string) => Promise<boolean | null>;
  } = {},
): Promise<{
  runs: UpcomingRun[];
  stopped: UpcomingStopReason | null;
}> {
  const parsed = PreviewNextRunSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError(
      400,
      "VALIDATION",
      "invalid preview input",
      parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    );
  }
  const d = parsed.data;
  // 注入假日函数时跳过“已配置”检查：注入源即数据源（单测/未来调用方），路由永不注入，生产行为不变
  if (d.skipHolidays && !opts.isHolidayFn && !isHolidayConfigured()) {
    throw new AppError(400, "VALIDATION", "holiday API not configured (HOLIDAY_API_URL/APP_KEY)");
  }
  const from = d.from ? new Date(d.from) : new Date();
  if (d.runAt) {
    const at = new Date(d.runAt);
    if (at.getTime() <= from.getTime()) {
      return { runs: [], stopped: "no-future-schedule" };
    }
    if (d.skipHolidays) {
      const adjusted = await adjustForHolidays({
        candidate: at,
        policy: d.holidayPolicy as HolidayPolicy,
        timezone: d.timezone ?? DEFAULT_TIMEZONE,
        // 一次性无“下一次”：drop 撞假日即作废（creation 侧对应 400，這里返回 stopped 告知）
        nextAfter: () => null,
        ...(opts.isHolidayFn ? { isHolidayFn: opts.isHolidayFn } : {}),
      });
      if (!adjusted) {
        return { runs: [], stopped: "no-future-schedule" };
      }
      return {
        runs: [{ scheduledAt: adjusted, holidayAdjusted: adjusted.getTime() !== at.getTime() }],
        stopped: "no-future-schedule",
      };
    }
    return { runs: [{ scheduledAt: at, holidayAdjusted: false }], stopped: "no-future-schedule" };
  }
  return computeUpcomingRuns(
    {
      cron: d.cron ?? null,
      scheduleIntervalSeconds: d.scheduleIntervalSeconds ?? null,
      timezone: d.timezone ?? DEFAULT_TIMEZONE,
      startsAt: d.startsAt ? new Date(d.startsAt) : null,
      endsAt: d.endsAt ? new Date(d.endsAt) : null,
      maxRuns: d.maxRuns ?? null,
      consumedRuns: 0,
      skipHolidays: d.skipHolidays,
      holidayPolicy: d.holidayPolicy,
    },
    { from: d.from ? new Date(d.from) : undefined, count: d.count, ...(opts.isHolidayFn ? { isHolidayFn: opts.isHolidayFn } : {}) },
  );
}

/**
 * 详情 enrichment（永不抛错）：一次性任务无节假日/结束规则，直接镜像存储值；
 * 重复任务算一次（count=1）；任何异常回 null，前端回退存储 nextRunAt 显示。
 */
async function safeUpcomingForRow(row: {
  cron: string | null;
  scheduleIntervalSeconds: number | null;
  timezone: string;
  startsAt: Date | null;
  endsAt: Date | null;
  maxRuns: number | null;
  consumedRuns: number | null;
  skipHolidays: boolean;
  holidayPolicy: string;
  nextRunAt: Date | null;
}): Promise<UpcomingInfo | null> {
  try {
    if (!row.cron && row.scheduleIntervalSeconds == null) {
      const at = row.nextRunAt;
      return {
        scheduledAt: at,
        holidayAdjusted: false,
        stoppedReason: at ? null : "no-future-schedule",
      };
    }
    const { runs, stopped } = await computeUpcomingRuns(
      {
        cron: row.cron,
        scheduleIntervalSeconds: row.scheduleIntervalSeconds,
        timezone: row.timezone,
        startsAt: row.startsAt,
        endsAt: row.endsAt,
        maxRuns: row.maxRuns,
        consumedRuns: Number(row.consumedRuns ?? 0),
        skipHolidays: row.skipHolidays,
        holidayPolicy: row.holidayPolicy,
      },
      { from: new Date(), count: 1 },
    );
    const first = runs[0] ?? null;
    return {
      scheduledAt: first?.scheduledAt ?? null,
      holidayAdjusted: first?.holidayAdjusted ?? false,
      stoppedReason: first ? null : stopped,
    };
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "upcoming preview failed, falling back to stored nextRunAt");
    return null;
  }
}

/** 假日调整（skipHolidays=false 直接返回原值，零开销）。 */
async function applyHolidayPolicy(
  next: Date | null,
  opts: {
    skipHolidays: boolean;
    holidayPolicy: string;
    timezone: string;
    schedule: { cron?: string | null; scheduleIntervalSeconds?: number | null };
  },
): Promise<Date | null> {
  if (!next || !opts.skipHolidays) {
    return next;
  }
  return adjustForHolidays({
    candidate: next,
    policy: opts.holidayPolicy as HolidayPolicy,
    timezone: opts.timezone,
    nextAfter: (d) => computeNextRun(opts.schedule, d, opts.timezone),
  });
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

function toView(row: TaskRow, upcoming: UpcomingInfo | null = null): TaskView {
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
    consumedRuns: Number(row.consumedRuns ?? 0),
    claimedBy: row.claimedBy ?? null,
    claimedUntil: row.claimedUntil ?? null,
    startsAt: row.startsAt,
    skipHolidays: row.skipHolidays,
    holidayPolicy: row.holidayPolicy,
    taskType: row.taskType,
    payload,
    enabled: row.enabled,
    disabledReason: row.disabledReason ?? null,
    disabledAt: row.disabledAt ?? null,
    disabledBy: row.disabledBy ?? null,
    maxAttempts: row.maxAttempts,
    timeoutMs: row.timeoutMs,
    recipients: row.recipients as string[],
    notifyOn: row.notifyOn as string[],
    webhookUrl: row.webhookUrl,
    emailSubjectTemplate: row.emailSubjectTemplate,
    emailBodyTemplate: row.emailBodyTemplate,
    emailSubjectTemplateFailed: row.emailSubjectTemplateFailed,
    emailBodyTemplateFailed: row.emailBodyTemplateFailed,
    emailAttachmentUrlTemplate: row.emailAttachmentUrlTemplate,
    systemUserId: (row as any).systemUserId ?? null,
    nextRunAt: row.nextRunAt,
    upcoming,
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
    data: rows.map((row) => toView(row)),
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
  return { ...toView(row), upcoming: await safeUpcomingForRow(row) };
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
  return { ...toViewAll(row, viewerTenantId), upcoming: await safeUpcomingForRow(row) };
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
  const startsAt = data.startsAt ? new Date(data.startsAt) : null;
  const schedule = { cron: data.cron, scheduleIntervalSeconds: data.scheduleIntervalSeconds };
  let nextRunAt = data.runAt
    ? new Date(data.runAt)
    : resolveFirstRun(schedule, startsAt, timezone, new Date());
  if (!nextRunAt) {
    throw new AppError(400, "VALIDATION", "schedule yields no future run");
  }
  if (data.endsAt && new Date(data.endsAt).getTime() <= nextRunAt.getTime()) {
    throw new AppError(400, "VALIDATION", "endsAt is before the first scheduled run");
  }
  if (data.skipHolidays && !isHolidayConfigured()) {
    throw new AppError(400, "VALIDATION", "holiday API not configured (HOLIDAY_API_URL/APP_KEY)");
  }
  nextRunAt = await applyHolidayPolicy(nextRunAt, {
    skipHolidays: data.skipHolidays,
    holidayPolicy: data.holidayPolicy,
    timezone,
    schedule,
  });
  if (!nextRunAt) {
    throw new AppError(400, "VALIDATION", "schedule yields no future run");
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
    startsAt: data.startsAt ? new Date(data.startsAt) : null,
    skipHolidays: data.skipHolidays,
    holidayPolicy: data.holidayPolicy,
    taskType: data.taskType,
    payload: publicPayload,
    payloadSecrets: secretBytes ? new Uint8Array(secretBytes) : null,
    enabled: data.enabled,
    maxAttempts: data.maxAttempts,
    timeoutMs: data.timeoutMs,
    recipients: data.recipients as Prisma.InputJsonValue,
    notifyOn: data.notifyOn as Prisma.InputJsonValue,
    webhookUrl: data.webhookUrl ?? null,
    emailSubjectTemplate: data.emailSubjectTemplate ?? null,
    emailBodyTemplate: data.emailBodyTemplate ?? null,
    emailSubjectTemplateFailed: data.emailSubjectTemplateFailed ?? null,
    emailBodyTemplateFailed: data.emailBodyTemplateFailed ?? null,
    emailAttachmentUrlTemplate: data.emailAttachmentUrlTemplate ?? null,
    ...(data.systemUserId ? { systemUserId: data.systemUserId } : {}),
    webhookSecret: data.webhookUrl ? new Uint8Array(encryptSecret(generateWebhookSecret())) : null,
    // 任务执行请求签名密钥：每个 http 任务自动生成（加密存）；取值恒走 env（对方单密钥验签），
    // Phase 2 对方按任务验签后启用本列
    execSignSecret:
      data.taskType === "http" ? new Uint8Array(encryptSecret(generateWebhookSecret())) : null,
    nextRunAt,
  });
  return { ...toView(row), upcoming: await safeUpcomingForRow(row) };
}

export async function update(
  tenantId: string,
  id: string,
  input: unknown,
  opts: { actorTokenId?: string } = {},
): Promise<TaskView> {
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

  // 配额账本重置（显式动作，非编辑副作用）：
  // - 仅停用态可调：启用态直接 400（防误触多发配额；想刷运行中任务的配额请先停用）。
  // - 与本次其它写入进同一条 updateMany（version 谓词），单语句原子，无中间态。
  // - 分布式安全：claim 谓词只读行状态，停用态下调度领取本来就拿不到行；manual 永不计数；
  //   读-写间隙若有在途执行 +1（它在创建时已合法占位），重置不影响其执行、不超发，
  //   最坏只是审计日志里的旧值差 1。
  const resettingQuota = data.resetConsumedRuns === true;
  if (resettingQuota && existing.enabled) {
    throw new AppError(400, "VALIDATION", "quota can only be reset on a disabled task");
  }
  const effectiveConsumed = resettingQuota ? 0 : Number(existing.consumedRuns ?? 0);
  const effectiveMaxRuns = data.maxRuns !== undefined ? data.maxRuns : existing.maxRuns;
  const effectiveEndsAt =
    data.endsAt !== undefined ? (data.endsAt ? new Date(data.endsAt) : null) : existing.endsAt;

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
  const policyTouched =
    scheduleTouched ||
    "timezone" in data ||
    "startsAt" in data ||
    "skipHolidays" in data ||
    "holidayPolicy" in data ||
    "endsAt" in data;
  if (policyTouched) {
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
    // 结束规则/重叠策略/开始时刻/节假日仅重复调度可配；单独出现时按既有调度校验（一次任务 → 400）
    const endRuleTouched =
      "endsAt" in data ||
      "maxRuns" in data ||
      "overlapPolicy" in data ||
      "startsAt" in data ||
      "skipHolidays" in data ||
      "holidayPolicy" in data;
    if (endRuleTouched && effKind === "runAt") {
      throw new AppError(
        400,
        "VALIDATION",
        "run-once tasks take no end rules, startsAt, holiday rules or overlap policy",
      );
    }
    const effSkipHolidays =
      data.skipHolidays !== undefined ? data.skipHolidays : existing.skipHolidays;
    if (effSkipHolidays && !isHolidayConfigured()) {
      throw new AppError(400, "VALIDATION", "holiday API not configured (HOLIDAY_API_URL/APP_KEY)");
    }
    const effTimezone =
      data.timezone !== undefined ? (data.timezone ?? DEFAULT_TIMEZONE) : existing.timezone;
    timezoneToStore = effKind === "cron" || effKind === "runAt" ? effTimezone : DEFAULT_TIMEZONE;
    const effStartsAt =
      data.startsAt !== undefined
        ? data.startsAt
          ? new Date(data.startsAt)
          : null
        : existing.startsAt;
    const effSchedule = {
      cron: (effCron ?? undefined) as string | undefined,
      scheduleIntervalSeconds: (effInterval ?? undefined) as number | undefined,
    };
    const effPolicy =
      data.holidayPolicy !== undefined ? data.holidayPolicy : existing.holidayPolicy;
    nextRunAt = effRunAt
      ? effRunAt
      : await applyHolidayPolicy(
          resolveFirstRun(effSchedule, effStartsAt, effTimezone, new Date()),
          {
            skipHolidays: effSkipHolidays,
            holidayPolicy: effPolicy,
            timezone: effTimezone,
            schedule: effSchedule,
          },
        );
    const effEndsAt =
      data.endsAt !== undefined ? (data.endsAt ? new Date(data.endsAt) : null) : existing.endsAt;
    if (effEndsAt && nextRunAt && effEndsAt.getTime() <= nextRunAt.getTime()) {
      throw new AppError(400, "VALIDATION", "endsAt is before the first scheduled run");
    }
  }
  // 停用原因写时定夺：手动停用打 manual 戳；重启用清空（上次怎么停的不污染下一次）
  let stopFields: Prisma.TaskUpdateInput | undefined;
  if (data.enabled === false) {
    nextRunAt = null;
    // 手动停用：写时定夺停用原因（重启用/自动停用会覆盖或清空）
    stopFields = {
      disabledReason: "manual",
      disabledAt: new Date(),
      disabledBy: opts.actorTokenId ?? null,
    };
  } else if (data.enabled === true && existing.enabled === false) {
    // 重启用：按既有调度（含一次性时刻与时区）重算；已过的一次性时刻由 worker 到期即领
    const reSchedule = {
      cron: (existing.cron ?? undefined) as string | undefined,
      scheduleIntervalSeconds: (existing.scheduleIntervalSeconds ?? undefined) as
        | number
        | undefined,
    };
    const reFirst = existing.runAt
      ? existing.runAt
      : resolveFirstRun(reSchedule, existing.startsAt, existing.timezone, new Date());
    nextRunAt = await applyHolidayPolicy(reFirst, {
      skipHolidays: existing.skipHolidays,
      holidayPolicy: existing.holidayPolicy,
      timezone: existing.timezone,
      schedule: reSchedule,
    });
    // 重启用 fail-fast：有问题的复活直接 400，不进“启用又立刻死”循环。
    // 判的是生效后值（重置/同包新规则都已折入），与创建校验同口径。
    if (effectiveMaxRuns != null && effectiveConsumed >= effectiveMaxRuns) {
      throw new AppError(
        400,
        "VALIDATION",
        `quota exhausted (consumed ${effectiveConsumed}/${effectiveMaxRuns}): raise maxRuns or reset quota first`,
      );
    }
    if (effectiveEndsAt && nextRunAt && effectiveEndsAt.getTime() <= nextRunAt.getTime()) {
      throw new AppError(400, "VALIDATION", "endsAt is before the first scheduled run");
    }
    if (!nextRunAt && !existing.runAt) {
      // 重复调度算不出下次（cron 年份过期等）：拒绝启用僵尸任务。
      // runAt 单次除外——已过时刻按既有语义由 worker 到期即领。
      throw new AppError(400, "VALIDATION", "schedule yields no future run");
    }
    // 重启用清空停用原因三字段
    stopFields = { disabledReason: null, disabledAt: null, disabledBy: null };
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
      ...(data.startsAt !== undefined && {
        startsAt: data.startsAt ? new Date(data.startsAt) : null,
      }),
      ...(data.skipHolidays !== undefined && { skipHolidays: data.skipHolidays }),
      ...(data.holidayPolicy !== undefined && { holidayPolicy: data.holidayPolicy }),
      ...(data.taskType !== undefined && { taskType: data.taskType }),
      ...(payloadUpdate !== undefined && { payload: payloadUpdate }),
      ...(secretsUpdate !== undefined && {
        payloadSecrets: secretsUpdate ? new Uint8Array(secretsUpdate) : null,
      }),
      ...(data.enabled !== undefined && { enabled: data.enabled }),
      ...(stopFields ?? {}),
      // 配额清零与其它写入同一语句（version 谓词），原子提交
      ...(resettingQuota && { consumedRuns: 0 }),
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
      ...(data.emailSubjectTemplate !== undefined && {
        emailSubjectTemplate: data.emailSubjectTemplate,
      }),
      ...(data.emailBodyTemplate !== undefined && {
        emailBodyTemplate: data.emailBodyTemplate,
      }),
      ...(data.emailSubjectTemplateFailed !== undefined && {
        emailSubjectTemplateFailed: data.emailSubjectTemplateFailed,
      }),
      ...(data.emailBodyTemplateFailed !== undefined && {
        emailBodyTemplateFailed: data.emailBodyTemplateFailed,
      }),
      ...(data.emailAttachmentUrlTemplate !== undefined && {
        emailAttachmentUrlTemplate: data.emailAttachmentUrlTemplate,
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
  if (resettingQuota) {
    // 配额重置审计（对齐 sign secret 轮换口径）；consumed_before 是读时快照，
    // 读-写间隙的在途 +1 只影响这个数字，不影响正确性（见上）。
    logger.warn(
      {
        task_id: id,
        actor: opts.actorTokenId ?? null,
        consumed_before: Number(existing.consumedRuns ?? 0),
      },
      "quota reset",
    );
  }
  return { ...toView(row), upcoming: await safeUpcomingForRow(row) };
}

export async function remove(tenantId: string, id: string): Promise<void> {
  // 硬删除（v1）：同一事务内先清 outbox/执行，避免 FK（run_id→execution、task_id）冲突；
  // 归档表无 FK，顺手按 taskId 清掉（webhook 归档有 taskId 列，无需 join）。
  const result = await prisma.$transaction(async (tx) => {
    // 归属前置：跨租户直接 404，避免先删后判误删数据
    const owned = await tx.task.findFirst({ where: { id, tenantId }, select: { id: true } });
    if (!owned) {
      throw new AppError(404, "NOT_FOUND", "task not found");
    }
    const executions = await tx.taskExecution.findMany({
      where: { taskId: id },
      select: { id: true },
    });
    // 先清 outbox（FK: run_id → execution），再删 task（onDelete: Cascade 级联 executions）
    await tx.emailLog.deleteMany({ where: { runId: { in: executions.map((e) => e.id) } } });
    await tx.webhookDelivery.deleteMany({ where: { runId: { in: executions.map((e) => e.id) } } });
    await tx.$executeRawUnsafe(`DELETE FROM email_log_archive WHERE task_id = ?`, id);
    await tx.$executeRawUnsafe(`DELETE FROM webhook_delivery_archive WHERE task_id = ?`, id);
    await tx.$executeRawUnsafe(`DELETE FROM task_execution_archive WHERE task_id = ?`, id);
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

/**
 * 密钥交接读取（供接收方验签）：仅 api-token + 租户隔离（跨租户 404，不泄露存在性）。
 * 读到明文即记审计；CRUD 永远不返回密钥的铁律不变。
 */
export async function getSignSecrets(
  tenantId: string,
  id: string,
): Promise<{ taskId: string; webhookSecret: string | null; execSignSecret: string | null }> {
  const row = await prisma.task.findFirst({
    where: { id, tenantId },
    select: { id: true, webhookSecret: true, execSignSecret: true },
  });
  if (!row) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }
  logger.info({ task_id: id }, "sign secrets viewed");
  return {
    taskId: row.id,
    webhookSecret: row.webhookSecret ? decryptSecret(new Uint8Array(row.webhookSecret)) : null,
    execSignSecret: row.execSignSecret ? decryptSecret(new Uint8Array(row.execSignSecret)) : null,
  };
}

/**
 * 密钥轮换：生成新密钥并明文返回一次；在途 outbox 快照行照旧（只影响之后入 outbox 的）。
 * 轮换必须跟接收方约同一分钟操作，否则窗口期内对方验签 401。
 */
export async function rotateSignSecret(
  tenantId: string,
  id: string,
  key: "webhookSecret" | "execSignSecret",
): Promise<{ taskId: string; key: string; secret: string }> {
  const existing = await prisma.task.findFirst({ where: { id, tenantId } });
  if (!existing) {
    throw new AppError(404, "NOT_FOUND", "task not found");
  }
  if (key === "webhookSecret" && !existing.webhookUrl) {
    throw new AppError(400, "VALIDATION", "no webhook configured, nothing to rotate");
  }
  if (key === "execSignSecret" && existing.taskType !== "http") {
    throw new AppError(400, "VALIDATION", "only http tasks carry an exec sign secret");
  }
  const secret = generateWebhookSecret();
  const encrypted = new Uint8Array(encryptSecret(secret));
  if (key === "webhookSecret") {
    await prisma.task.updateMany({ where: { id, tenantId }, data: { webhookSecret: encrypted } });
  } else {
    await prisma.task.updateMany({ where: { id, tenantId }, data: { execSignSecret: encrypted } });
  }
  logger.warn({ task_id: id, key }, "sign secret rotated");
  return { taskId: id, key, secret };
}
