import { config } from "../src/lib/config";
import { prisma } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { archiveMovedTotal } from "../src/lib/metrics";

/**
 * retention 归档（任务 5）：把超期终态行搬进 *_archive 表。
 * 规则：只搬终态旧行——execution 取终态（pending/running 不碰），outbox 只搬 sent
 * （pending/failed/in_progress/dead 全留：重试/回收/redrive 链不断）。
 * 力学：主键分片小批量（INSERT IGNORE + 按 id 清单 DELETE），并发多 pod 自然收敛，
 * 无锁无选主；FK 顺序先 outbox 后 execution，且 execution 要求无活表 outbox 引用
 * （dead 邮件留活表，其 execution 陪着留，否则 FK 1451）。
 * 配额列 consumedRuns 不碰（计数含已归档，配额永不复活）；幂等键随行归档，
 * 重复认领只发生在秒级窗口，90 天延迟的重复物理不可达（改天数时重估此条）。
 * Redis 缝：纯 DB 家务，永不迁移（注释锁死，省得后人瞎迁）。
 */

/** 单批行数：小事务不锁表。 */
const ARCHIVE_BATCH = 5000;
/** 单轮 time-box：历史欠账分天还，不搞 megadelete。 */
const ARCHIVE_TIME_BUDGET_MS = 5 * 60 * 1000;

export interface ArchiveSummary {
  table: string;
  moved: number;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

async function moveBatch(opts: {
  live: string;
  archive: string;
  insertCols: string;
  selectCols: string;
  fromJoin: string;
  statusPredicate: string;
  createdAtCol: string;
  cutoff: Date;
  /** 额外 guard（AND 拼接）：execution 归档要求无活表 outbox 引用（dead 邮件留活表，其 execution 必须陪着留，否则 FK 1451） */
  extraGuard?: string;
}): Promise<number> {
  const guard = opts.extraGuard ? ` AND ${opts.extraGuard}` : "";
  const ids = (await prisma.$queryRawUnsafe(
    `SELECT id FROM ${opts.live} WHERE ${opts.statusPredicate} AND ${opts.createdAtCol} < ?${guard} ORDER BY id LIMIT ${ARCHIVE_BATCH}`,
    opts.cutoff,
  )) as Array<{ id: bigint | string }>;
  if (ids.length === 0) {
    return 0;
  }
  const values = ids.map((r) => r.id);
  const ph = placeholders(values.length);
  await prisma.$executeRawUnsafe(
    `INSERT IGNORE INTO ${opts.archive} (${opts.insertCols}) SELECT ${opts.selectCols} FROM ${opts.fromJoin} WHERE ${opts.live}.id IN (${ph})`,
    ...values,
  );
  // 搬运一致性断言：归档缺行就不删（并发重叠/写入失败时停下，下轮继续）
  const verified = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM ${opts.archive} WHERE id IN (${ph})`,
    ...values,
  )) as Array<{ n: bigint | number }>;
  if (Number(verified[0]?.n ?? 0) !== values.length) {
    logger.error({ table: opts.live, want: values.length }, "archive verify failed, keeping live rows");
    return -1;
  }
  const deleted = (await prisma.$executeRawUnsafe(
    `DELETE FROM ${opts.live} WHERE id IN (${ph})`,
    ...values,
  )) as unknown as number;
  return Number(deleted);
}

const EMAIL_COLS = [
  "id",
  "run_id",
  "task_id",
  "tenant_id",
  "to_address",
  "subject",
  "html",
  "text",
  "status",
  "attempts",
  "max_attempts",
  "message_id",
  "provider_response",
  "last_error",
  "next_retry_at",
  "sent_at",
  "created_at",
  "updated_at",
  "system_user_id",
  "attachment_url",
].join(", ");

const EXECUTION_COLS = [
  "id",
  "task_id",
  "idempotency_key",
  "scheduled_at",
  "started_at",
  "finished_at",
  "status",
  "attempt",
  "duration_ms",
  "error",
  "`trigger`",
  "system_user_id",
  "email_expected",
  "webhook_expected",
  "notify_snapshot",
  "created_at",
].join(", ");

const WEBHOOK_COLS = [
  "id",
  "run_id",
  "tenant_id",
  "webhook_url",
  "payload",
  "webhook_secret",
  "status",
  "attempts",
  "max_attempts",
  "signature",
  "response_code",
  "last_error",
  "next_retry_at",
  "sent_at",
  "system_user_id",
  "created_at",
  "updated_at",
].join(", ");

const TERMINAL_EXECUTION = "status IN ('succeeded', 'failed', 'timeout', 'dead', 'skipped', 'interrupted')";

export async function runArchiveOnce(now = new Date()): Promise<ArchiveSummary[]> {
  const cutoff = new Date(now.getTime() - config.RETENTION_DAYS * 86400 * 1000);
  const started = Date.now();
  const out: ArchiveSummary[] = [];
  // 先 outbox（FK 指向 execution），后 execution
  const jobs: Array<{ table: string; fn: () => Promise<number> }> = [
    {
      table: "email_log",
      fn: () =>
        moveBatch({
          live: "email_log",
          archive: "email_log_archive",
          insertCols: EMAIL_COLS,
          selectCols: EMAIL_COLS,
          fromJoin: "email_log",
          statusPredicate: "status = 'sent'",
          createdAtCol: "created_at",
          cutoff,
        }),
    },
    {
      table: "webhook_delivery",
      fn: () =>
        moveBatch({
          live: "webhook_delivery",
          archive: "webhook_delivery_archive",
          insertCols: `${WEBHOOK_COLS}, task_id`,
          selectCols: `${WEBHOOK_COLS.split(", ")
            .map((c) => `webhook_delivery.${c.trim()}`)
            .join(", ")}, task_execution.task_id`,
          fromJoin: "webhook_delivery JOIN task_execution ON task_execution.id = webhook_delivery.run_id",
          statusPredicate: "webhook_delivery.status = 'sent'",
          createdAtCol: "webhook_delivery.created_at",
          cutoff,
        }),
    },
    {
      table: "task_execution",
      fn: () =>
        moveBatch({
          live: "task_execution",
          archive: "task_execution_archive",
          insertCols: EXECUTION_COLS,
          selectCols: EXECUTION_COLS,
          fromJoin: "task_execution",
          statusPredicate: TERMINAL_EXECUTION,
          createdAtCol: "created_at",
          cutoff,
          extraGuard:
            "NOT EXISTS (SELECT 1 FROM email_log WHERE email_log.run_id = task_execution.id) AND NOT EXISTS (SELECT 1 FROM webhook_delivery WHERE webhook_delivery.run_id = task_execution.id)",
        }),
    },
  ];
  for (const job of jobs) {
    let moved = 0;
    for (;;) {
      if (Date.now() - started > ARCHIVE_TIME_BUDGET_MS) {
        logger.warn({ table: job.table, moved }, "archive time-boxed, continue tomorrow");
        break;
      }
      const n = await job.fn();
      if (n <= 0) {
        break;
      }
      moved += n;
      archiveMovedTotal.inc({ table: job.table }, n);
    }
    out.push({ table: job.table, moved });
  }
  return out;
}
