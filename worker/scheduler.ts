import { Prisma } from "@prisma/client";
import { createPool } from "../src/lib/concurrency";
import { computeNextRun } from "../src/lib/cron";
import { prisma } from "../src/lib/db";
import type { RunTaskDefinition } from "../src/modules/execution/service";

/**
 * 调度器（research.md §2 / FR-005/FR-014/FR-012）：
 * - 到期任务领取：单事务内 `SELECT ... FOR UPDATE SKIP LOCKED` + 租约 + 推进 next_run_at。
 * - 手动运行（run-now）领取：status='pending' AND trigger='manual' 的执行行（SKIP LOCKED）。
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

/** 领取到期任务 + 手动执行（单事务，SKIP LOCKED）。 */
export async function claimDueItems(
  workerId: string,
  leaseSeconds: number,
  batchSize: number,
): Promise<ClaimItem[]> {
  const items = await prisma.$transaction(async (tx) => {
    const items: ClaimItem[] = [];

    // 1) 到期任务
    const due = (await tx.$queryRaw(
      Prisma.sql`
        SELECT ${TASK_COLUMNS}
        FROM task
        WHERE enabled = 1 AND next_run_at <= NOW()
          AND (claimed_until IS NULL OR claimed_until < NOW())
        ORDER BY next_run_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `,
    )) as DueRow[];

    for (const row of due) {
      const next = computeNextRun(
        { cron: row.cron, scheduleIntervalSeconds: row.scheduleIntervalSeconds },
        new Date(),
      );
      await tx.$executeRaw(
        Prisma.sql`
          UPDATE task
          SET claimed_by = ${workerId},
              claimed_until = DATE_ADD(NOW(), INTERVAL ${leaseSeconds} SECOND),
              next_run_at = ${next},
              enabled = ${next ? 1 : 0}
          WHERE id = ${row.id}
        `,
      );
      items.push({
        kind: "scheduled",
        task: toTaskDefinition(row),
        scheduledAt: new Date(row.nextRunAt),
      });
    }

    // 2) 手动运行（run-now 入队的 pending 执行行）
    const manual = (await tx.$queryRaw(
      Prisma.sql`
        SELECT te.id, te.scheduled_at AS scheduledAt, te.task_id AS taskId
        FROM task_execution te
        WHERE te.status = 'pending' AND te.trigger = 'manual'
        ORDER BY te.created_at ASC
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
      `,
    )) as Array<{ id: string; scheduledAt: Date; taskId: string }>;

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
        await tx.$executeRaw(
          Prisma.sql`UPDATE task_execution SET status = 'running' WHERE id = ${exec.id}`,
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
