import "dotenv/config";
import os from "node:os";
import { prisma } from "../src/lib/db";
import { config } from "../src/lib/config";
import { logger } from "../src/lib/logger";
import { registerDefaultExecutors } from "../src/modules/execution/register";
import { outboxPending, workerHeartbeats } from "../src/lib/metrics";
import { claimDueItems, advanceMissedRuns, reclaimExpiredLeases } from "./scheduler";
import { createRunner } from "./runner";
import { runEmailRelayOnce } from "./relay";
import { runWebhookRelayOnce } from "./webhook-relay";

/**
 * worker 进程入口（research.md §6 / FR-011）：
 * - 每轮：领取到期任务+手动运行 → 有界并发执行；随后跑邮件/Webhook 中继。
 * - SIGTERM/SIGINT 优雅排空在途任务，干净退出。
 * - uncaughtException / unhandledRejection → 记录后非零退出（交进程管理器重启）。
 */

const workerId = `wk-${os.hostname()}-${process.pid}`;
const INTERVAL_MS = config.WORKER_POLL_INTERVAL_MS;
const LEASE_SECONDS = config.WORKER_LEASE_SECONDS;
const BATCH_SIZE = config.WORKER_BATCH_SIZE;

registerDefaultExecutors();

const runner = createRunner(config.WORKER_MAX_CONCURRENCY);
let shuttingDown = false;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function heartbeat(): Promise<void> {
  try {
    await prisma.workerLease.upsert({
      where: { instanceId: workerId },
      create: {
        instanceId: workerId,
        lastHeartbeatAt: new Date(),
        status: "active",
        claimedRunIds: [],
      },
      update: { lastHeartbeatAt: new Date(), status: "active" },
    });
    workerHeartbeats.inc({ worker_id: workerId });
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "heartbeat failed");
  }
}

/** 输出 outbox 待投递水位（每轮刷新）。 */
async function refreshOutboxGauge(): Promise<void> {
  try {
    const [email, webhook] = await Promise.all([
      prisma.emailLog.count({ where: { status: "pending" } }),
      prisma.webhookDelivery.count({ where: { status: "pending" } }),
    ]);
    outboxPending.set(email + webhook);
  } catch {
    // 指标刷新失败不中断
  }
}

async function runLoop(): Promise<void> {
  while (!shuttingDown) {
    const started = Date.now();
    try {
      const claimed = await claimDueItems(workerId, LEASE_SECONDS, BATCH_SIZE);
      if (claimed.length > 0) {
        await runner.runAll(claimed);
      }
    } catch (error) {
      logger.error({ err: (error as Error).message }, "poll cycle failed (will retry)");
    }

    // 终态通知中继（outbox → 投递），错误不中断主循环
    if (!shuttingDown) {
      await runEmailRelayOnce(20).catch((error) =>
        logger.error({ err: (error as Error).message }, "email relay failed"),
      );
    }
    void refreshOutboxGauge();
    if (!shuttingDown) {
      await runWebhookRelayOnce(20).catch((error) =>
        logger.error({ err: (error as Error).message }, "webhook relay failed"),
      );
    }

    const elapsed = Date.now() - started;
    if (!shuttingDown) {
      await sleep(Math.max(100, INTERVAL_MS - elapsed));
    }
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "worker draining");
  await runner.drain(config.SHUTDOWN_GRACE_MS).catch(() => {});
  await prisma.workerLease
    .update({
      where: { instanceId: workerId },
      data: { status: "draining" },
    })
    .catch(() => {});
  await prisma.$disconnect().catch(() => {});
  logger.info("worker exited cleanly");
  process.exit(0);
}

["SIGTERM", "SIGINT"].forEach((signal) => {
  process.on(signal as NodeJS.Signals, () => {
    void shutdown(signal as NodeJS.Signals);
  });
});

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaughtException — exiting 1");
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandledRejection — exiting 1");
  process.exit(1);
});

async function main(): Promise<void> {
  logger.info(
    { workerId, pollMs: INTERVAL_MS, concurrency: config.WORKER_MAX_CONCURRENCY },
    "worker starting",
  );

  // 重启对账：推进停机期间错过的运行（不补跑）
  const advanced = await advanceMissedRuns();
  if (advanced > 0) {
    logger.info({ advanced }, "advanced missed runs after restart");
  }
  const reclaimed = await reclaimExpiredLeases();
  if (reclaimed > 0) {
    logger.info({ reclaimed }, "reclaimed expired leases");
  }

  void setInterval(() => void heartbeat(), Math.max(5000, INTERVAL_MS * 2));
  await heartbeat();

  await runLoop();
}

main().catch((error) => {
  logger.fatal({ err: error }, "worker main failed");
  process.exit(1);
});