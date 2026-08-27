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
  taskType: string;
  timeoutMs: number | bigint;
  maxAttempts: number | bigint;
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
    recipients: (parseJsonColumn(row.recipients, []) as string[]) ?? [],
    notifyOn: (parseJsonColumn(row.notifyOn, []) as string[]) ?? [],
    webhookUrl: row.webhookUrl,
    webhookSecret: toBytes(row.webhookSecret),
  };
}

const TASK_COLUMNS = Prisma.sql`
  id, cron, schedule_interval_seconds AS scheduleIntervalSeconds,
  task_type AS taskType, timeout_ms AS timeoutMs, max_attempts AS maxAttempts,
  payload, payload_secrets AS payloadSecrets, next_run_at AS nextRunAt,
  tenant_id AS tenantId, name AS taskName, recipients, notify_on AS notifyOn,
  webhook_url AS webhookUrl, webhook_secret AS webhookSecret
`;

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

/** 手动运行候选查询：同上。 */
function pendingManualSelectSql(batchSize: number, skipLocked: boolean): Prisma.Sql {
  const tail = skipLocked ? Prisma.sql`FOR UPDATE SKIP LOCKED` : Prisma.sql``;
  return Prisma.sql`
    SELECT te.id, te.scheduled_at AS scheduledAt, te.task_id AS taskId
    FROM task_execution te
    WHERE te.status = 'pending' AND te.trigger = 'manual'
    ORDER BY te.created_at ASC
    LIMIT ${batchSize}
    ${tail}
  `;
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

    for (const row of due) {
      const next = computeNextRun(
        { cron: row.cron, scheduleIntervalSeconds: row.scheduleIntervalSeconds },
        new Date(),
      );
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

    // 2) 手动运行（run-now 入队的 pending 执行行）
    const manual = (await tx.$queryRaw(pendingManualSelectSql(batchSize, skipLocked))) as Array<{
      id: string;
      scheduledAt: Date;
      taskId: string;
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
        // 兼容路径下抢不到（status 已非 pending）则跳过；SKIP LOCKED 路径必命中。
        const claimed = await tx.$executeRaw(
          Prisma.sql`UPDATE task_execution SET status = 'running' WHERE id = ${exec.id} AND status = 'pending'`,
        );
        if (claimed === 0) {
          continue;
        }
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
  const missed = await prisma.task.findMany({
    where: { enabled: true, nextRunAt: { lte: now } },
    select: { id: true, cron: true, scheduleIntervalSeconds: true },
  });
  if (missed.length === 0) {
    return 0;
  }
  const pool = createPool(16);
  await Promise.all(
    missed.map((task) =>
      pool.run(async () => {
        const next = computeNextRun(
          { cron: task.cron, scheduleIntervalSeconds: task.scheduleIntervalSeconds },
          now,
        );
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

// 兼容旧名（集成测试/旧调用）
export { claimDueItems as claimDueTasks };
