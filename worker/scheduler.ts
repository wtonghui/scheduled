import { Prisma } from "@prisma/client";
import { createPool } from "../src/lib/concurrency";
import { computeNextRun } from "../src/lib/cron";
import { prisma } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import type { RunTaskDefinition } from "../src/modules/execution/service";

/**
 * 调度器（research.md §2 / FR-005/FR-014/FR-012）：
 * - 到期任务领取：单事务内 `SELECT ... FOR UPDATE SKIP LOCKED`（服务器支持时）+ 租约 + 推进 next_run_at。
 * - 低版本兼容：MySQL < 8.0.1 / MariaDB < 10.6 不支持 SKIP LOCKED，自动退化为
 *   「条件 UPDATE + 受影响行数」的可移植领取（与 outbox 领取同一模式），多实例判定等价。
 * - 手动运行（run-now）领取：status='pending' AND trigger='manual' 的执行行。
 * - 重启对账 + 租约回收（T038）。
 */

export type ClaimItem =
  | { kind: "scheduled"; task: RunTaskDefinition; scheduledAt: Date }
  | { kind: "manual"; task: RunTaskDefinition; scheduledAt: Date; executionId: string };

export type { RunTaskDefinition };

interface DueRow {
  id: string;
  cron: string | null;
  scheduleIntervalSeconds: number | null;
  timezone: string;
  overlapPolicy: string;
  endsAt: Date | null;
  maxRuns: number | bigint | null;
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
  };
}

const TASK_COLUMNS = Prisma.sql`
  id, cron, schedule_interval_seconds AS scheduleIntervalSeconds,
  timezone, overlap_policy AS overlapPolicy, ends_at AS endsAt, max_runs AS maxRuns,
  task_type AS taskType, timeout_ms AS timeoutMs, max_attempts AS maxAttempts,
  retry_delay_ms AS retryDelayMs,
  payload, payload_secrets AS payloadSecrets, next_run_at AS nextRunAt,
  tenant_id AS tenantId, name AS taskName, recipients, notify_on AS notifyOn,
  webhook_url AS webhookUrl, webhook_secret AS webhookSecret
`;

/** 已消耗的调度次数：attempt=1 且 trigger 为调度触发的行；run-now/重试行/跳过行不计（D3/D4）。
 * 用 Prisma 类型化 groupBy（非 raw SQL）规避 MySQL `trigger` 保留字反引号问题。 */
async function countScheduledRuns(
  tx: Parameters<Parameters<(typeof prisma)["$transaction"]>[0]>[0],
  taskIds: string[],
): Promise<Map<string, number>> {
  const used = new Map<string, number>();
  if (taskIds.length === 0) {
    return used;
  }
  const counts = await tx.taskExecution.groupBy({
    by: ["taskId"],
    where: {
      taskId: { in: taskIds },
      attempt: 1,
      trigger: { in: ["scheduled", "queued"] },
      status: { not: "skipped" },
    },
    _count: { taskId: true },
  });
  for (const c of counts) {
    used.set(c.taskId, c._count.taskId);
  }
  return used;
}

/** 结束规则命中即停用：无下次 / 超过 endsAt / 跑满 maxRuns（三者谁先到谁停）。 */
function endRuleExhausted(
  next: Date | null,
  endsAt: Date | null,
  maxRuns: number | bigint | null,
  used: number,
): boolean {
  if (!next) {
    return true;
  }
  if (endsAt && next.getTime() > endsAt.getTime()) {
    return true;
  }
  if (maxRuns != null && used >= Number(maxRuns)) {
    return true;
  }
  return false;
}

/** 调度触发执行行补跑宽限期：created_at 距今超过该秒数才允许被别实例（补跑）领取，
 * 防「创建→转 running」微秒窗口被并发实例顺手偷走。 */
const PENDING_RECLAIM_GRACE_SECONDS = 5;

/** SKIP LOCKED 能力探测结果缓存（进程内仅探测一次）。 */
let skipLockedSupportedCache: boolean | null = null;

/**
 * 服务器是否支持 `SELECT ... FOR UPDATE SKIP LOCKED`：
 * MySQL ≥ 8.0.1 或 MariaDB ≥ 10.6 支持。探测失败时保守按"不支持"处理（可移植路径不影响正确性）。
 */
async function supportsSkipLocked(): Promise<boolean> {
  if (skipLockedSupportedCache !== null) {
    return skipLockedSupportedCache;
  }
  try {
    const rows = (await prisma.$queryRaw(Prisma.sql`SELECT VERSION() AS version`)) as Array<{
      version: string;
    }>;
    const version = rows[0]?.version ?? "";
    const isMaria = /mariadb/i.test(version);
    const [, majStr = "0", minStr = "0"] = /^(\d+)\.(\d+)/.exec(version) ?? [];
    const major = Number(majStr);
    const minor = Number(minStr);
    const supported = isMaria
      ? major > 10 || (major === 10 && minor >= 6)
      : major > 8 || (major === 8 && minor >= 1);
    skipLockedSupportedCache = supported;
    logger.info({ version, skipLocked: supported }, "claim: sql capability probe");
    return supported;
  } catch (error) {
    logger.warn({ err: error }, "claim: SKIP LOCKED probe failed; using portable claim sql");
    skipLockedSupportedCache = false;
    return false;
  }
}

/** 到期任务候选查询：支持 SKIP LOCKED 时加锁跳过，否则不带（归属交由条件 UPDATE 判定）。 */
function dueTasksSelectSql(batchSize: number, skipLocked: boolean): Prisma.Sql {
  const tail = skipLocked ? Prisma.sql`FOR UPDATE SKIP LOCKED` : Prisma.sql``;
  return Prisma.sql`
    SELECT ${TASK_COLUMNS}
    FROM task
    WHERE enabled = 1 AND next_run_at <= NOW()
      AND (claimed_until IS NULL OR claimed_until < NOW())
    ORDER BY next_run_at ASC
    LIMIT ${batchSize}
    ${tail}
  `;
}

/** 手动运行/补跑/排队候选查询：pending 执行行（run-now、排队行或符合条件的陈旧遗留行）均可领取。
 * 调度触发行加「created_at 早于宽限期」门槛：正常 worker 创建→立即转 running（微秒级），
 * 只有创建者已死的陈旧 pending 才被补跑；手动/排队触发故意等待领取，不受宽限。
 * 用 $queryRawUnsafe + 反引号规避 MySQL `trigger` 保留字（Prisma.sql 模板内无法含反引号）。 */
function pendingExecutionsSelectSql(
  batchSize: number,
  skipLocked: boolean,
): { sql: string; params: number[] } {
  const tail = skipLocked ? "FOR UPDATE SKIP LOCKED" : "";
  return {
    sql: `SELECT te.id, te.scheduled_at AS scheduledAt, te.task_id AS taskId, te.\`trigger\` AS \`trigger\`
      FROM task_execution te
      WHERE te.status = 'pending'
        AND (te.\`trigger\` IN ('manual', 'queued')
              OR te.created_at < DATE_SUB(NOW(), INTERVAL ? SECOND))
      ORDER BY te.created_at ASC
      LIMIT ? ${tail}`,
    params: [PENDING_RECLAIM_GRACE_SECONDS, batchSize],
  };
}

/**
 * 领取到期任务 + 手动执行（单事务）。
 * 服务器支持时用 `FOR UPDATE SKIP LOCKED`；低版本 MySQL/MariaDB 自动退化为
 * 「条件 UPDATE + 受影响行数」判定归属（并发下抢不到的候选行直接跳过，多实例仍恰好一次）。
 * @param skipLockedOverride 测试用：强制走/不走 SKIP LOCKED 路径；缺省探测服务器版本。
 */
export async function claimDueItems(
  workerId: string,
  leaseSeconds: number,
  batchSize: number,
  skipLockedOverride?: boolean,
): Promise<ClaimItem[]> {
  const skipLocked = skipLockedOverride ?? (await supportsSkipLocked());
  const items = await prisma.$transaction(async (tx) => {
    const items: ClaimItem[] = [];

    // 1) 到期任务
    const due = (await tx.$queryRaw(dueTasksSelectSql(batchSize, skipLocked))) as DueRow[];
    const usedMap = await countScheduledRuns(
      tx,
      due.map((row) => row.id),
    );

    for (const row of due) {
      const next = computeNextRun(
        { cron: row.cron, scheduleIntervalSeconds: row.scheduleIntervalSeconds },
        new Date(),
        row.timezone,
      );
      // 结束规则命中 → 停用且不产生本次执行（配额用尽/过期不审计，与 overlap 跳过区分）。
      // 注意 next==null 不在此列：到期的一次性任务（runAt）无下次但本轮欠一次，
      // 走原领取路径执行一次并停用（既有语义）。
      if (
        (next && row.endsAt && next.getTime() > row.endsAt.getTime()) ||
        (row.maxRuns != null && (usedMap.get(row.id) ?? 0) >= Number(row.maxRuns))
      ) {
        await tx.$executeRaw(
          Prisma.sql`UPDATE task SET next_run_at = NULL, enabled = 0 WHERE id = ${row.id}`,
        );
        continue;
      }
      // 归属判定：SKIP LOCKED 下持有行锁必命中；兼容路径下若已被别实例抢先，affectedRows=0 → 跳过。
      const claimed = await tx.$executeRaw(
        Prisma.sql`
          UPDATE task
          SET claimed_by = ${workerId},
              claimed_until = DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND),
              next_run_at = ${next},
              enabled = ${next ? 1 : 0}
          WHERE id = ${row.id}
            AND (claimed_until IS NULL OR claimed_until < NOW())
        `,
      );
      if (claimed === 0) {
        continue;
      }
      items.push({
        kind: "scheduled",
        task: toTaskDefinition(row),
        scheduledAt: new Date(row.nextRunAt),
      });
    }

    // 2) 被租约挡住的到期任务（上次仍在跑）：到期但租约有效，正常路径领不到，
    // 按 overlapPolicy 处理。next 推进后本 tick 不再到期，同 tick 最多留一行审计/排队。
    const blocked = (await tx.$queryRaw(
      Prisma.sql`
        SELECT ${TASK_COLUMNS}, system_user_id AS systemUserId
        FROM task
        WHERE enabled = 1 AND next_run_at <= NOW()
          AND claimed_until IS NOT NULL AND claimed_until > NOW()
        ORDER BY next_run_at ASC
        LIMIT ${batchSize}
        ${skipLocked ? Prisma.sql`FOR UPDATE SKIP LOCKED` : Prisma.sql``}
      `,
    )) as Array<DueRow & { systemUserId: string | null; nextRunAt: Date }>;
    if (blocked.length > 0) {
      const blockedUsed = await countScheduledRuns(
        tx,
        blocked.map((row) => row.id),
      );
      for (const row of blocked) {
        const tick = new Date(row.nextRunAt);
        const next = computeNextRun(
          { cron: row.cron, scheduleIntervalSeconds: row.scheduleIntervalSeconds },
          new Date(),
          row.timezone,
        );
        if (
          (next && row.endsAt && next.getTime() > row.endsAt.getTime()) ||
          (row.maxRuns != null && (blockedUsed.get(row.id) ?? 0) >= Number(row.maxRuns))
        ) {
          await tx.$executeRaw(
            Prisma.sql`UPDATE task SET next_run_at = NULL, enabled = 0 WHERE id = ${row.id}`,
          );
          continue;
        }
        if (row.overlapPolicy === "run") {
          // 显式允许并行：无视租约强领（用户自担双跑风险）
          const claimed = await tx.$executeRaw(
            Prisma.sql`
              UPDATE task
              SET claimed_by = ${workerId},
                  claimed_until = DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND),
                  next_run_at = ${next},
                  enabled = ${next ? 1 : 0}
              WHERE id = ${row.id}
            `,
          );
          if (claimed === 0) {
            continue;
          }
          items.push({
            kind: "scheduled",
            task: toTaskDefinition(row),
            scheduledAt: tick,
          });
          continue;
        }
        // 推进时刻（条件更新防并发复写），再按策略留痕
        const advanced = await tx.$executeRaw(
          Prisma.sql`UPDATE task SET next_run_at = ${next}, enabled = ${next ? 1 : 0}
            WHERE id = ${row.id} AND next_run_at <= NOW()`,
        );
        if (advanced === 0) {
          continue;
        }
        const kind = row.overlapPolicy === "queue" ? "queued" : "skipped";
        const status = row.overlapPolicy === "queue" ? "pending" : "skipped";
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
        } catch (error) {
          // 并发实例同 tick 双写 → 幂等键冲突，忽略（对方已留痕）
          if ((error as { code?: string }).code !== "P2002") {
            throw error;
          }
        }
      }
    }

    // 3) 运行/补跑/排队候选：pending 执行行（run-now、排队行或符合条件的陈旧遗留行）
    const pendingQuery = pendingExecutionsSelectSql(batchSize, skipLocked);
    const manual = (await tx.$queryRawUnsafe(pendingQuery.sql, ...pendingQuery.params)) as Array<{
      id: string;
      scheduledAt: Date;
      taskId: string;
      trigger: string;
    }>;

    if (manual.length > 0) {
      const taskRows = (await tx.$queryRaw(
        Prisma.sql`
          SELECT ${TASK_COLUMNS}
          FROM task
          WHERE id IN (${Prisma.join(manual.map((m) => m.taskId))})
        `,
      )) as DueRow[];
      const byId = new Map(taskRows.map((row) => [row.id, row]));
      for (const exec of manual) {
        const row = byId.get(exec.taskId);
        if (!row) {
          continue;
        }
        if (exec.trigger === "queued") {
          // 排队行：上次仍在跑（租约有效）则继续等，不抢跑；租约释放后领取
          const lease = (await tx.$queryRaw(
            Prisma.sql`SELECT claimed_until AS claimedUntil FROM task WHERE id = ${exec.taskId}`,
          )) as Array<{ claimedUntil: Date | null }>;
          const held = lease[0]?.claimedUntil && lease[0].claimedUntil.getTime() > Date.now();
          if (held) {
            continue;
          }
        }
        // 兼容路径下抢不到（status 已非 pending）则跳过；SKIP LOCKED 路径必命中。
        const claimed = await tx.$executeRaw(
          Prisma.sql`UPDATE task_execution SET status = 'running' WHERE id = ${exec.id} AND status = 'pending'`,
        );
        if (claimed === 0) {
          continue;
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
    }

    return items;
  });
  return items;
}

/**
 * 重启对账：停机期间错过的运行不补跑，仅推进到下一未来运行。
 * 有界并发批量推进，避免"停机久 + 任务多"时逐条串行 update 拖慢重启（原 N+1）。
 * 语义不变：`enabled` 只在无未来运行点时置 false。
 */
export async function advanceMissedRuns(now = new Date()): Promise<number> {
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
      cron: true,
      scheduleIntervalSeconds: true,
      timezone: true,
      endsAt: true,
      maxRuns: true,
    },
  });
  if (missed.length === 0) {
    return 0;
  }
  const counts = await prisma.taskExecution.groupBy({
    by: ["taskId"],
    where: {
      taskId: { in: missed.map((t) => t.id) },
      attempt: 1,
      trigger: { in: ["scheduled", "queued"] },
      status: { not: "skipped" },
    },
    _count: { taskId: true },
  });
  const usedMap = new Map(counts.map((c) => [c.taskId, c._count.taskId]));
  const pool = createPool(16);
  await Promise.all(
    missed.map((task) =>
      pool.run(async () => {
        const next = computeNextRun(
          { cron: task.cron, scheduleIntervalSeconds: task.scheduleIntervalSeconds },
          now,
          task.timezone,
        );
        if (endRuleExhausted(next, task.endsAt, task.maxRuns, usedMap.get(task.id) ?? 0)) {
          await prisma.task.update({
            where: { id: task.id },
            data: { nextRunAt: null, enabled: false },
          });
          return;
        }
        await prisma.task.update({
          where: { id: task.id },
          data: { nextRunAt: next, ...(next ? {} : { enabled: false }) },
        });
      }),
    ),
  );
  return missed.length;
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
