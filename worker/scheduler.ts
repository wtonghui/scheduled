import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { createPool } from "../src/lib/concurrency";
import { computeNextRun } from "../src/lib/cron";
import { prisma } from "../src/lib/db";
import { type HolidayPolicy, adjustForHolidays } from "../src/lib/holiday";
import { logger } from "../src/lib/logger";
import { taskClaimDurationMs } from "../src/lib/metrics";
import type { RunTaskDefinition } from "../src/modules/execution/service";

/**
 * 调度器（research.md §2 / FR-005/FR-014/FR-012）：
 * - 到期任务领取（三段式）：READ（无事务候选+计数+推进计算）→ WRITE（单短事务条件认领）
 *   → SETTLE（失败重读定夺）。归属唯一靠写谓词（tick 等值/maxRuns/endsAt/租约），
 *   单语句原子，任意 MySQL/MariaDB 版本、多 pod 同一语义。
 * - 手动运行（run-now）领取：status='pending' AND trigger='manual' 的执行行。
 * - 重启对账 + 租约回收（T038）。
 */

export type ClaimItem =
  | { kind: "scheduled"; task: RunTaskDefinition; scheduledAt: Date }
  | { kind: "manual"; task: RunTaskDefinition; scheduledAt: Date; executionId: string };

/**
 * 自动停用原因（写时定夺，与 TaskStopReason 枚举同值）：
 * run_once_done 单次跑完 / ends_at 到截止 / max_runs 到次数 / no_future_schedule 无未来计划。
 * 优先级与 planDueRow 一致：先 maxRuns 再 endsAt（共存时谁先命中记谁）。
 */
export type AutoStopReason = "run_once_done" | "ends_at" | "max_runs" | "no_future_schedule";

export type { RunTaskDefinition };

interface DueRow {
  id: string;
  cron: string | null;
  runAt: Date | null;
  scheduleIntervalSeconds: number | null;
  timezone: string;
  overlapPolicy: string;
  endsAt: Date | null;
  maxRuns: number | bigint | null;
  consumedRuns: number | bigint;
  skipHolidays: boolean;
  holidayPolicy: string;
  taskType: string;
  timeoutMs: number | bigint;
  maxAttempts: number | bigint;
  retryDelayMs: number | bigint | null;
  payload: unknown;
  payloadSecrets: Uint8Array | string | null;
  nextRunAt: Date;
  tenantId: string;
  taskName: string;
  recipients: string;
  notifyOn: string;
  webhookUrl: string | null;
  webhookSecret: Uint8Array | string | null;
  emailSubjectTemplate: string | null;
  emailBodyTemplate: string | null;
  emailSubjectTemplateFailed: string | null;
  emailBodyTemplateFailed: string | null;
  emailAttachmentUrlTemplate: string | null;
  execSignSecret: Uint8Array | string | null;
  systemUserId: string | null;
}

function parseJsonColumn(value: unknown, fallback: unknown = {}): unknown {
  if (value == null) {
    return fallback;
  }
  if (typeof value === "string") {
    try {
      return JSON.parse(value) as unknown;
    } catch {
      return fallback;
    }
  }
  return value;
}

function toBytes(value: Uint8Array | string | null): Uint8Array | null {
  if (value == null) {
    return null;
  }
  return typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
}

function toTaskDefinition(row: DueRow): RunTaskDefinition {
  return {
    id: row.id,
    tenantId: row.tenantId,
    taskName: row.taskName,
    taskType: row.taskType === "noop" ? "noop" : "http",
    payload: (parseJsonColumn(row.payload, {}) as Record<string, unknown>) ?? {},
    payloadSecrets: toBytes(row.payloadSecrets),
    timeoutMs: Number(row.timeoutMs),
    maxAttempts: Number(row.maxAttempts),
    retryDelayMs: row.retryDelayMs == null ? null : Number(row.retryDelayMs),
    recipients: (parseJsonColumn(row.recipients, []) as string[]) ?? [],
    notifyOn: (parseJsonColumn(row.notifyOn, []) as string[]) ?? [],
    webhookUrl: row.webhookUrl,
    webhookSecret: toBytes(row.webhookSecret),
    emailSubjectTemplate: row.emailSubjectTemplate,
    emailBodyTemplate: row.emailBodyTemplate,
    emailSubjectTemplateFailed: row.emailSubjectTemplateFailed,
    emailBodyTemplateFailed: row.emailBodyTemplateFailed,
    emailAttachmentUrlTemplate: row.emailAttachmentUrlTemplate,
    execSignSecret: toBytes(row.execSignSecret),
    systemUserId: row.systemUserId ?? null,
  };
}

const TASK_COLUMNS = Prisma.sql`
  id, cron, run_at AS runAt, schedule_interval_seconds AS scheduleIntervalSeconds,
  timezone, overlap_policy AS overlapPolicy, ends_at AS endsAt, max_runs AS maxRuns,
  consumed_runs AS consumedRuns,
  skip_holidays AS skipHolidays, holiday_policy AS holidayPolicy,
  task_type AS taskType, timeout_ms AS timeoutMs, max_attempts AS maxAttempts,
  retry_delay_ms AS retryDelayMs,
  payload, payload_secrets AS payloadSecrets, next_run_at AS nextRunAt,
  tenant_id AS tenantId, name AS taskName, recipients, notify_on AS notifyOn,
  webhook_url AS webhookUrl, webhook_secret AS webhookSecret,
  email_subject_template AS emailSubjectTemplate,
  email_body_template AS emailBodyTemplate,
  email_subject_template_failed AS emailSubjectTemplateFailed,
  email_body_template_failed AS emailBodyTemplateFailed,
  email_attachment_url_template AS emailAttachmentUrlTemplate,
  exec_sign_secret AS execSignSecret, system_user_id AS systemUserId
`;

/** 假日调整（skipHolidays=false 直接返回原值，零开销；失败 fail-open 在 holiday 模块内）。 */
async function applyTaskHolidays(
  next: Date | null,
  row: {
    cron: string | null;
    scheduleIntervalSeconds: number | null;
    timezone: string;
    skipHolidays: boolean;
    holidayPolicy: string;
  },
): Promise<Date | null> {
  if (!next || !row.skipHolidays) {
    return next;
  }
  const schedule = { cron: row.cron, scheduleIntervalSeconds: row.scheduleIntervalSeconds };
  return adjustForHolidays({
    candidate: next,
    policy: (row.holidayPolicy as HolidayPolicy) ?? "drop",
    timezone: row.timezone,
    nextAfter: (d) => computeNextRun(schedule, d, row.timezone),
  });
}

/** 调度触发执行行补跑宽限期：created_at 距今超过该秒数才允许被别实例（补跑）领取，
 * 防「创建→转 running」微秒窗口被并发实例顺手偷走。 */
const PENDING_RECLAIM_GRACE_SECONDS = 5;

/** 到期任务候选查询（无锁 plain SELECT；归属由写阶段条件 UPDATE 裁决，见 claimDueItems）。 */
function dueTasksSelectSql(batchSize: number): Prisma.Sql {
  return Prisma.sql`
    SELECT ${TASK_COLUMNS}
    FROM task
    WHERE enabled = 1 AND next_run_at <= NOW()
      AND (claimed_until IS NULL OR claimed_until < NOW())
    ORDER BY next_run_at ASC
    LIMIT ${batchSize}
  `;
}

/** 被租约挡住的到期任务（上次仍在跑）：到期但租约有效，走 overlapPolicy 分支。 */
function blockedTasksSelectSql(batchSize: number): Prisma.Sql {
  return Prisma.sql`
    SELECT ${TASK_COLUMNS}
    FROM task
    WHERE enabled = 1 AND next_run_at <= NOW()
      AND claimed_until IS NOT NULL AND claimed_until > NOW()
    ORDER BY next_run_at ASC
    LIMIT ${batchSize}
  `;
}

/** 手动运行/补跑/排队候选查询：pending 执行行（run-now、排队行或符合条件的陈旧遗留行）均可领取。
 * 调度触发行加「created_at 早于宽限期」门槛：正常 worker 创建→立即转 running（微秒级），
 * 只有创建者已死的陈旧 pending 才被补跑；手动/排队触发故意等待领取，不受宽限。
 * 用 $queryRawUnsafe + 反引号规避 MySQL `trigger` 保留字（Prisma.sql 模板内无法含反引号）。 */
function pendingExecutionsSelectSql(batchSize: number): { sql: string; params: number[] } {
  return {
    sql: `SELECT te.id, te.scheduled_at AS scheduledAt, te.task_id AS taskId, te.\`trigger\` AS \`trigger\`
      FROM task_execution te
      WHERE te.status = 'pending'
        AND (te.\`trigger\` IN ('manual', 'queued')
              OR te.created_at < DATE_SUB(NOW(), INTERVAL ? SECOND))
      ORDER BY te.created_at ASC
      LIMIT ?`,
    params: [PENDING_RECLAIM_GRACE_SECONDS, batchSize],
  };
}

interface DuePlan {
  row: DueRow;
  tick: Date;
  advanceTo: Date | null;
  action: "claim" | "disable";
  /** 停用原因：disable 必有；claim 仅 advanceTo==null 时有（本轮跑完即止） */
  stopReason: AutoStopReason | null;
}

/**
 * 自动停用原因判定（纯函数，供 claim/对账共用）：
 * advanceTo 非空 → 任务继续，无原因；为空 → 按 maxRuns → endsAt → runAt → 无未来计划判定。
 */
export function resolveAutoStopReason(
  row: { runAt: Date | null; endsAt: Date | null; maxRuns: number | bigint | null; consumedRuns: number | bigint },
  tick: Date,
  rawNext: Date | null,
  advanceTo: Date | null,
): AutoStopReason | null {
  if (advanceTo) {
    return null;
  }
  if (row.maxRuns != null && Number(row.consumedRuns ?? 0) >= Number(row.maxRuns)) {
    return "max_runs";
  }
  if (row.endsAt && tick.getTime() > row.endsAt.getTime()) {
    return "ends_at";
  }
  // 下次已超截止（tick 仍在窗口内，本轮跑完即止）
  if (row.endsAt && rawNext && rawNext.getTime() > row.endsAt.getTime()) {
    return "ends_at";
  }
  if (row.runAt) {
    return "run_once_done";
  }
  return "no_future_schedule";
}

/**
 * 推进计算（READ 阶段，无事务）：配额读 consumedRuns 列（建议性预检，省掉无用 holiday 调用），
 * 写阶段谓词裁决。先假日调整再判结束规则（被顺延/跳过的 tick 不占配额，超 endsAt 才停）。
 */
async function planDueRow(row: DueRow, now: Date): Promise<DuePlan> {
  const tick = new Date(row.nextRunAt);
  // maxRuns 计已执行次数：用尽则本轮不跑（跑了就超配额）
  if (row.maxRuns != null && Number(row.consumedRuns ?? 0) >= Number(row.maxRuns)) {
    return { row, tick, advanceTo: null, action: "disable", stopReason: "max_runs" };
  }
  // endsAt 按本轮 tick 判定（tick 在窗口内就执行；重算的下次超窗只影响推进）
  if (row.endsAt && tick.getTime() > row.endsAt.getTime()) {
    return { row, tick, advanceTo: null, action: "disable", stopReason: "ends_at" };
  }
  const rawNext = computeNextRun(
    { cron: row.cron, scheduleIntervalSeconds: row.scheduleIntervalSeconds },
    now,
    row.timezone,
  );
  // 注意 next==null 不拦执行：到期的一次性任务（runAt）无下次但本轮欠一次，
  // 走原领取路径执行一次并停用（既有语义）
  const next = await applyTaskHolidays(rawNext, row);
  const advanceTo = next && row.endsAt && next.getTime() > row.endsAt.getTime() ? null : next;
  return { row, tick, advanceTo, action: "claim", stopReason: resolveAutoStopReason(row, tick, next, advanceTo) };
}

/**
 * 到期认领 UPDATE（方案 C 谓词 + retention 计数列）：tick 等值 guard 防过期覆盖；
 * endsAt 谓词 + consumedRuns 列比较进语句（单语句原子，配额永不超发，归档不影响）；
 * claimed_until 谓词保恰好一次。
 * tick 精度假设：next_run_at 全经 JS Date 写入（毫秒精度），DB 往返无损，等值安全。
 */
function claimDueSql(plan: DuePlan, workerId: string, leaseSeconds: number): Prisma.Sql {
  const { row, tick, advanceTo, stopReason } = plan;
  // 停用原因与停用写原子同行：继续跑则清空（重启用语义），停用则写时定夺
  const stopColumns = advanceTo
    ? Prisma.sql`, disabled_reason = NULL, disabled_at = NULL, disabled_by = NULL`
    : Prisma.sql`, disabled_reason = ${stopReason}, disabled_at = NOW(), disabled_by = ${workerId}`;
  return Prisma.sql`
    UPDATE task
    SET claimed_by = ${workerId},
        claimed_until = DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND),
        next_run_at = ${advanceTo},
        enabled = ${advanceTo ? 1 : 0}
        ${stopColumns}
    WHERE id = ${row.id}
      AND next_run_at = ${tick}
      AND (claimed_until IS NULL OR claimed_until < NOW())
      AND (ends_at IS NULL OR ${tick} <= ends_at)
      AND (max_runs IS NULL OR consumed_runs < max_runs)
  `;
}

/**
 * 认领失败定夺（SETTLE 阶段，事务外，只走失败路径）：重读区分被抢先（tick 已变→不管）、
 * 配额用尽/超窗（条件停用，tick guard 防覆盖）。误判最多多打日志，不影响正确性。
 */
async function settleFailedClaim(plan: DuePlan, workerId: string): Promise<void> {
  const { row, tick } = plan;
  const fresh = await prisma.task.findUnique({
    where: { id: row.id },
    select: { nextRunAt: true, maxRuns: true, consumedRuns: true, endsAt: true, runAt: true },
  });
  if (!fresh?.nextRunAt || fresh.nextRunAt.getTime() !== tick.getTime()) {
    return; // 被别实例推进/停用/删除：不管
  }
  if (fresh.maxRuns != null) {
    if (Number(fresh.consumedRuns ?? 0) >= Number(fresh.maxRuns)) {
      await prisma.task.updateMany({
        where: { id: row.id, nextRunAt: tick },
        data: { nextRunAt: null, enabled: false, disabledReason: "max_runs", disabledAt: new Date(), disabledBy: workerId },
      });
      return;
    }
  }
  if (fresh.endsAt && tick.getTime() > fresh.endsAt.getTime()) {
    await prisma.task.updateMany({
      where: { id: row.id, nextRunAt: tick },
      data: { nextRunAt: null, enabled: false, disabledReason: "ends_at", disabledAt: new Date(), disabledBy: workerId },
    });
  }
  // 租约竞输：下轮再领
}

/**
 * 领取到期任务 + 手动执行（三段式，任务 1 拆事务后）：
 * READ（无事务：候选 SELECT + 计数 + next/假日计算）→ WRITE（单短事务：只 UPDATE/INSERT）
 * → SETTLE（事务外：认领失败重读定夺停用/跳过）。
 * 正确性不靠事务/行锁，靠写谓词（方案 C）：tick 等值 guard 防过期覆盖；
 * maxRuns/endsAt 谓词进认领 UPDATE（单语句原子），配额永不超发；
 * queued 领取带 NOT EXISTS 租约谓词。多 pod/任意 DB 版本同一语义（SKIP LOCKED 已删）。
 * @param _skipLockedOverride 已废弃：保留签名免改调用方，无视此参数。
 */
export async function claimDueItems(
  workerId: string,
  leaseSeconds: number,
  batchSize: number,
  _skipLockedOverride?: boolean,
): Promise<ClaimItem[]> {
  const started = Date.now();
  const now = new Date();

  // ── READ ──
  const due = (await prisma.$queryRaw(dueTasksSelectSql(batchSize))) as DueRow[];
  const blocked = (await prisma.$queryRaw(blockedTasksSelectSql(batchSize))) as DueRow[];
  // 假日计算并行（并发 8 写死；isHoliday 自带 24h 缓存+同 tick 去重，同天同 zone 基本 1 次 API）
  const holidayPool = createPool(8);
  const plans = await Promise.all(
    due.map((row) => holidayPool.run(() => planDueRow(row, now))),
  );
  const blockedPlans = await Promise.all(
    blocked.map((row) => holidayPool.run(() => planDueRow(row, now))),
  );
  const pendingQuery = pendingExecutionsSelectSql(batchSize);
  const manual = (await prisma.$queryRawUnsafe(pendingQuery.sql, ...pendingQuery.params)) as Array<{
    id: string;
    scheduledAt: Date;
    taskId: string;
    trigger: string;
  }>;
  const byId = new Map<string, DueRow>();
  if (manual.length > 0) {
    const taskRows = (await prisma.$queryRaw(
      Prisma.sql`
        SELECT ${TASK_COLUMNS}
        FROM task
        WHERE id IN (${Prisma.join(manual.map((m) => m.taskId))})
      `,
    )) as DueRow[];
    for (const row of taskRows) {
      byId.set(row.id, row);
    }
  }
  // queued 租约初筛（建议；裁决在写阶段 NOT EXISTS 谓词）
  const leaseUntil = new Map<string, number | null>();
  const queuedTaskIds = [
    ...new Set(manual.filter((m) => m.trigger === "queued").map((m) => m.taskId)),
  ];
  if (queuedTaskIds.length > 0) {
    const leases = (await prisma.$queryRaw(
      Prisma.sql`SELECT id, claimed_until AS claimedUntil FROM task WHERE id IN (${Prisma.join(queuedTaskIds)})`,
    )) as Array<{ id: string; claimedUntil: Date | null }>;
    for (const l of leases) {
      leaseUntil.set(l.id, l.claimedUntil ? l.claimedUntil.getTime() : null);
    }
  }
  const readMs = Date.now() - started;

  // ── WRITE（单短事务）──
  const items: ClaimItem[] = [];
  const failures: DuePlan[] = [];
  // due/blocked 同 tick 去重（读分两次，租约恰好过期会两边都出现；先到先得，输家走 settle）
  const handled = new Set<string>();
  const writeStarted = Date.now();
  await prisma.$transaction(async (tx) => {
    // 1) 到期任务
    for (const plan of plans) {
      if (handled.has(plan.row.id)) {
        continue;
      }
      handled.add(plan.row.id);
      if (plan.action === "disable") {
        // 停用条件写时重验（READ 快照可能已过期：用户放宽 endsAt/maxRuns 后谓词不成立则 0 行跳过，下轮正常领取）
        await tx.$executeRaw(
          Prisma.sql`UPDATE task SET next_run_at = NULL, enabled = 0,
              disabled_reason = ${plan.stopReason}, disabled_at = NOW(), disabled_by = ${workerId}
            WHERE id = ${plan.row.id} AND next_run_at = ${plan.tick}
            AND ((max_runs IS NOT NULL AND consumed_runs >= max_runs)
              OR (ends_at IS NOT NULL AND ${plan.tick} > ends_at))`,
        );
        continue;
      }
      // 归属判定：谓词全中才命中；被别实例抢先则 affectedRows=0 → settle 定夺
      const claimed = await tx.$executeRaw(claimDueSql(plan, workerId, leaseSeconds));
      if (claimed === 0) {
        failures.push(plan);
        continue;
      }
      items.push({
        kind: "scheduled",
        task: toTaskDefinition(plan.row),
        scheduledAt: plan.tick,
      });
    }

    // 2) 被租约挡住的到期任务（上次仍在跑）：按 overlapPolicy 处理
    for (const plan of blockedPlans) {
      const { row, tick, advanceTo } = plan;
      if (handled.has(row.id)) {
        continue; // due 侧已处理同 tick（读分两次的交错窗口）
      }
      handled.add(row.id);
      if (plan.action === "disable") {
        // 同上：停用条件写时重验，用户放宽配置后 0 行跳过
        await tx.$executeRaw(
          Prisma.sql`UPDATE task SET next_run_at = NULL, enabled = 0,
              disabled_reason = ${plan.stopReason}, disabled_at = NOW(), disabled_by = ${workerId}
            WHERE id = ${row.id} AND next_run_at = ${tick}
            AND ((max_runs IS NOT NULL AND consumed_runs >= max_runs)
              OR (ends_at IS NOT NULL AND ${tick} > ends_at))`,
        );
        continue;
      }
      if (row.overlapPolicy === "run") {
        // 显式允许并行：无视租约强领（用户自担双跑风险），但 tick guard + endsAt/maxRuns 谓词仍要：
        // 读写之间配额被打满时写瞬间驳回（0 行 → settle 定夺停用），配额永不超发
        // 停用原因与停用写原子同行：继续跑则清空，重启用语义
        const stopColumns =
          plan.advanceTo != null
            ? Prisma.sql`, disabled_reason = NULL, disabled_at = NULL, disabled_by = NULL`
            : Prisma.sql`, disabled_reason = ${plan.stopReason}, disabled_at = NOW(), disabled_by = ${workerId}`;
        const claimed = await tx.$executeRaw(
          Prisma.sql`
            UPDATE task
            SET claimed_by = ${workerId},
                claimed_until = DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND),
                next_run_at = ${advanceTo},
                enabled = ${advanceTo ? 1 : 0}
                ${stopColumns}
            WHERE id = ${row.id} AND next_run_at = ${tick}
              AND (ends_at IS NULL OR ${tick} <= ends_at)
              AND (max_runs IS NULL OR consumed_runs < max_runs)
          `,
        );
        if (claimed === 0) {
          failures.push(plan);
          continue;
        }
        items.push({
          kind: "scheduled",
          task: toTaskDefinition(row),
          scheduledAt: tick,
        });
        continue;
      }
      // 推进时刻（tick guard 防并发复写 + endsAt/maxRuns 写时重验；读写之间配额被打满则 0 行 → settle 定夺停用）
      // advanceTo==null 则本轮推进即止（plan.stopReason 已判：下次超窗 ends_at / 单次跑完 / 无未来计划）
      const blockedStopColumns =
        advanceTo != null
          ? Prisma.sql`, disabled_reason = NULL, disabled_at = NULL, disabled_by = NULL`
          : Prisma.sql`, disabled_reason = ${plan.stopReason}, disabled_at = NOW(), disabled_by = ${workerId}`;
      const advanced = await tx.$executeRaw(
        Prisma.sql`UPDATE task SET next_run_at = ${advanceTo}, enabled = ${advanceTo ? 1 : 0}
            ${blockedStopColumns}
          WHERE id = ${row.id} AND next_run_at = ${tick} AND next_run_at <= NOW()
            AND (ends_at IS NULL OR ${tick} <= ends_at)
            AND (max_runs IS NULL OR consumed_runs < max_runs)`,
      );
      if (advanced === 0) {
        failures.push(plan);
        continue;
      }
      const kind = row.overlapPolicy === "queue" ? "queued" : "skipped";
      const status = row.overlapPolicy === "queue" ? "pending" : "skipped";
      // 排队合并（A1 keep-newest）：新 tick 到达前把该任务更早的未领排队行翻成 skipped，
      // 每任务至多 1 行 pending 排队——防上游卡死时积压 N 行、释放后连跑 N 次过期数据并误烧 maxRuns。
      // 单语句原子，多 pod 幂等（第二个翻不到东西）；running 行不碰（够不着 pending），该跑的照跑。
      // skipped 不计配额（翻转时已扣回 consumedRuns），故一次突发只占 1 次配额。
      if (kind === "queued") {
        const superseded = await tx.taskExecution.updateMany({
          where: {
            taskId: row.id,
            trigger: "queued",
            status: "pending",
            scheduledAt: { lt: tick },
          },
          data: { status: "skipped" },
        });
        // 合并扣配额：被翻成 skipped 的旧排队不再占配额（skipped 不计数），按实际翻转数扣回
        if (superseded.count > 0) {
          await tx.task.update({
            where: { id: row.id },
            data: { consumedRuns: { decrement: superseded.count } },
          });
        }
      }
      try {
        // 类型化写入（列名 trigger 为保留字，raw 需反引号——模板内反引号与定界符冲突，故走 typed）
        await tx.taskExecution.create({
          data: {
            taskId: row.id,
            idempotencyKey: `${row.id}:${tick.toISOString()}:${kind}`,
            scheduledAt: tick,
            attempt: 1,
            trigger: kind,
            status: status as "pending" | "skipped",
            systemUserId: row.systemUserId,
          },
        });
        // 配额计数：queued 排队行创建即占配额（skipped 审计行不占）；只在真实创建时 +1，P2002 不加
        if (kind === "queued") {
          await tx.task.update({
            where: { id: row.id },
            data: { consumedRuns: { increment: 1 } },
          });
        }
      } catch (error) {
        // 并发实例同 tick 双写 → 幂等键冲突，忽略（对方已留痕）
        if ((error as { code?: string }).code !== "P2002") {
          throw error;
        }
      }
    }

    // 3) 运行/补跑/排队候选：pending 执行行（run-now、排队行或陈旧遗留行）
    for (const exec of manual) {
      const row = byId.get(exec.taskId);
      if (!row) {
        continue;
      }
      if (exec.trigger === "queued") {
        // 初筛（租约有效则等）+ 原子谓词双保险：写瞬间租约仍有效则认领失败，不抢跑
        const until = leaseUntil.get(exec.taskId);
        if (until != null && until > Date.now()) {
          continue;
        }
        const claimed = await tx.$executeRaw(
          Prisma.sql`UPDATE task_execution SET status = 'running'
            WHERE id = ${exec.id} AND status = 'pending'
            AND NOT EXISTS (SELECT 1 FROM task WHERE id = ${exec.taskId} AND claimed_until > NOW())`,
        );
        if (claimed === 0) {
          continue;
        }
      } else {
        // 抢不到（status 已非 pending）则跳过，多实例仍恰好一次
        const claimed = await tx.$executeRaw(
          Prisma.sql`UPDATE task_execution SET status = 'running' WHERE id = ${exec.id} AND status = 'pending'`,
        );
        if (claimed === 0) {
          continue;
        }
      }
      // 执行层领取同样给 task 打租约：运行=租约的证据，续租/孤儿对账统一走 task 行
      await tx.$executeRaw(
        Prisma.sql`
          UPDATE task SET claimed_by = ${workerId},
            claimed_until = DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND)
          WHERE id = ${row.id}
        `,
      );
      items.push({
        kind: "manual",
        task: toTaskDefinition(row),
        scheduledAt: new Date(exec.scheduledAt),
        executionId: exec.id,
      });
    }
  });
  const writeMs = Date.now() - writeStarted;

  // ── SETTLE（事务外）：认领失败重读定夺（停用/跳过），只走失败路径
  for (const plan of failures) {
    await settleFailedClaim(plan, workerId);
  }

  taskClaimDurationMs.observe({ phase: "read" }, readMs);
  taskClaimDurationMs.observe({ phase: "write" }, writeMs);
  logger.debug({ readMs, writeMs, claimed: items.length }, "claim round finished");
  return items;
}

/**
 * 对账单 flight 锁（worker_lease 固定行，多实例同时重启只放一个进去）：
 * 连接无关的原子认领——INSERT 保行存在 + 条件 UPDATE 抢锁（idle 或心跳超 TTL 才可偷），
 * 崩溃遗留的锁至多 TTL 后被后来者接管；holder 记在 claimed_run_ids，释放只放自己的。
 */
const ADVANCE_LOCK_ID = "advance-missed-runs";
const ADVANCE_LOCK_TTL_SECONDS = 120;

async function tryAcquireAdvanceLock(holder: string): Promise<boolean> {
  await prisma.$executeRaw`INSERT IGNORE INTO worker_lease (instance_id, last_heartbeat_at, status)
    VALUES (${ADVANCE_LOCK_ID}, DATE_SUB(NOW(), INTERVAL 1 HOUR), 'idle')`;
  const claimed = await prisma.$executeRaw`UPDATE worker_lease
    SET claimed_run_ids = JSON_QUOTE(${holder}), last_heartbeat_at = NOW(), status = 'locked'
    WHERE instance_id = ${ADVANCE_LOCK_ID}
      AND (status = 'idle' OR last_heartbeat_at < DATE_SUB(NOW(), INTERVAL ${ADVANCE_LOCK_TTL_SECONDS} SECOND))`;
  return claimed === 1;
}

async function releaseAdvanceLock(holder: string): Promise<void> {
  // 注意：JSON_QUOTE() 返回的是 STRING 类型，与 JSON 列直接 = 比较恒为 0（实测），
  // 必须用 JSON_UNQUOTE(列) = 明文（MySQL/MariaDB 通用；CAST AS JSON 在 MariaDB 不支持）。
  await prisma.$executeRaw`UPDATE worker_lease SET status = 'idle'
    WHERE instance_id = ${ADVANCE_LOCK_ID} AND JSON_UNQUOTE(claimed_run_ids) = ${holder}`;
}

/**
 * 重启对账：停机期间错过的运行不补跑，仅推进到下一未来运行。
 * 有界并发批量推进，避免"停机久 + 任务多"时逐条串行 update 拖慢重启（原 N+1）。
 * 语义不变：`enabled` 只在无未来运行点时置 false。
 * 并发安全：单 flight（多实例同时重启只一个执行，其余 return 0）+ 所有写带 tick guard，
 * 停用写额外带条件谓词（写瞬间用最新值重验，防旧快照在用户放宽配置后误停）。
 */
export async function advanceMissedRuns(
  now = new Date(),
  holderId?: string,
  actorId = "scheduler",
): Promise<number> {
  const holder = holderId ?? randomUUID();
  if (!(await tryAcquireAdvanceLock(holder))) {
    logger.info("advanceMissedRuns skipped (another instance holds the lock)");
    return 0;
  }
  try {
    // 租约有效（上次仍在跑）的任务不在此推进，留给领取环节按 overlapPolicy 处理（跳过审计/排队），
    // 避免对账把运行中任务的 next_run_at 提前 yank 走
    const missed = await prisma.task.findMany({
      where: {
        enabled: true,
        nextRunAt: { lte: now },
        OR: [{ claimedUntil: null }, { claimedUntil: { lt: now } }],
      },
      select: {
        id: true,
        nextRunAt: true,
        cron: true,
        runAt: true,
        scheduleIntervalSeconds: true,
        timezone: true,
        endsAt: true,
        maxRuns: true,
        consumedRuns: true,
        skipHolidays: true,
        holidayPolicy: true,
      },
    });
    if (missed.length === 0) {
      return 0;
    }
    const pool = createPool(16);
    await Promise.all(
      missed.map((task) =>
        pool.run(async () => {
          const tick = task.nextRunAt;
          if (!tick) {
            return;
          }
          // maxRuns 用尽 → 直接停用（读 consumedRuns 列，不数全表；归档不影响）。
          // 写时重验：快照过期（用户放宽 maxRuns）或 tick 已被推进则 0 行跳过。
          if (task.maxRuns != null && Number(task.consumedRuns ?? 0) >= Number(task.maxRuns)) {
            await prisma.$executeRaw`UPDATE task SET next_run_at = NULL, enabled = 0,
                disabled_reason = 'max_runs', disabled_at = NOW(), disabled_by = ${actorId}
              WHERE id = ${task.id} AND next_run_at = ${tick}
                AND max_runs IS NOT NULL AND consumed_runs >= max_runs`;
            return;
          }
          // endsAt：本轮 tick 仍在窗口内 → 不动，留给领取循环执行（避免对账提前停用丢 tick）；
          // tick 已超窗 → 停用（写时重验，用户延长 endsAt 后 0 行跳过）。
          if (task.endsAt) {
            const tickTime = tick.getTime();
            if (tickTime <= task.endsAt.getTime()) {
              return;
            }
            await prisma.$executeRaw`UPDATE task SET next_run_at = NULL, enabled = 0,
                disabled_reason = 'ends_at', disabled_at = NOW(), disabled_by = ${actorId}
              WHERE id = ${task.id} AND next_run_at = ${tick}
                AND ends_at IS NOT NULL AND ${tick} > ends_at`;
            return;
          }
          const rawNext = computeNextRun(
            { cron: task.cron, scheduleIntervalSeconds: task.scheduleIntervalSeconds },
            now,
            task.timezone,
          );
          const next = await applyTaskHolidays(rawNext, task);
          // 到此 maxRuns/endsAt 已处理（上早退），只剩无下次 → 停用（tick guard 防盖住领取循环的推进）；
          // 单次任务归 run_once_done，其余归无未来计划
          if (!next) {
            const stopReason = task.runAt ? "run_once_done" : "no_future_schedule";
            await prisma.task.updateMany({
              where: { id: task.id, nextRunAt: tick },
              data: {
                nextRunAt: null,
                enabled: false,
                disabledReason: stopReason,
                disabledAt: new Date(),
                disabledBy: actorId,
              },
            });
            return;
          }
          await prisma.task.updateMany({
            where: { id: task.id, nextRunAt: tick },
            data: { nextRunAt: next },
          });
        }),
      ),
    );
    return missed.length;
  } finally {
    await releaseAdvanceLock(holder).catch((error) => {
      logger.warn({ err: (error as Error).message }, "release advance lock failed");
    });
  }
}

/** 租约回收（T038）：清扫 claimed_until < now 的孤儿领取。 */
export async function reclaimExpiredLeases(now = new Date()): Promise<number> {
  const result = await prisma.task.updateMany({
    where: { claimedUntil: { lt: now } },
    data: { claimedBy: null, claimedUntil: null },
  });
  return result.count;
}

/**
 * 执行中任务租约续期：长任务不丢租约 → 不被别实例/回收重复领取（恰好一次）。
 * 只续「自己认领」的行（claimed_by = workerId），不会拖走别人的任务。
 * @returns 续租成功的行数（小于 ids.length 说明有任务已丢租约/被接管）。
 */
export async function renewTaskLeases(
  ids: string[],
  workerId: string,
  leaseSeconds: number,
): Promise<number> {
  if (ids.length === 0) {
    return 0;
  }
  const result = await prisma.task.updateMany({
    where: { id: { in: ids }, claimedBy: workerId },
    data: { claimedUntil: new Date(Date.now() + leaseSeconds * 1000) },
  });
  return result.count;
}

/**
 * 孤儿执行对账（重启/周期调用）：worker 死亡遗留的 running 执行行 → 整定为 failed，
 * 并清掉其 task 上已过期的认领。**不重跑**（HTTP 可能已发出，避免双副作用）。
 * 幂等：只改仍为 running 的行；生命行（租约未过期/被活 worker 接管）不受影响。
 */
export async function reconcileOrphanExecutions(now = new Date()): Promise<number> {
  const orphans = await prisma.taskExecution.findMany({
    where: {
      status: "running",
      task: { is: { OR: [{ claimedUntil: { lt: now } }, { claimedUntil: null }] } },
    },
    select: { id: true, taskId: true, startedAt: true },
    take: 200,
  });
  if (orphans.length === 0) {
    return 0;
  }
  let handled = 0;
  for (const row of orphans) {
    const updated = await prisma.taskExecution.updateMany({
      where: { id: row.id, status: "running" },
      data: {
        status: "failed",
        finishedAt: new Date(),
        durationMs: row.startedAt ? Date.now() - row.startedAt.getTime() : null,
        error: { class: "timeout", message: "interrupted: worker lease expired" },
      },
    });
    if (updated.count === 0) {
      continue;
    }
    handled += 1;
    // 清过期认领（若该 task 已被活 worker 接管则这步自然无行可改）
    await prisma.task.updateMany({
      where: { id: row.taskId, claimedUntil: { lt: new Date() } },
      data: { claimedBy: null, claimedUntil: null },
    });
  }
  if (handled > 0) {
    logger.warn({ handled }, "reconciled orphaned running executions");
  }
  return handled;
}

// 兼容旧名（集成测试/旧调用）
export { claimDueItems as claimDueTasks };
