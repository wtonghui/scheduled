import "dotenv/config";
import os from "node:os";
import { config } from "../src/lib/config";
import { prisma } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { outboxDead, outboxFailed, outboxHealedTotal, outboxPending, outboxPendingByTenant, workerHeartbeats } from "../src/lib/metrics";
import { healMissingOutbox } from "../src/modules/notification/service";
import { registerDefaultExecutors } from "../src/modules/execution/register";
import { runArchiveOnce } from "./archive";
import { runEmailRelayOnce } from "./relay";
import { createRunner } from "./runner";
import {
  advanceMissedRuns,
  claimDueItems,
  reclaimExpiredLeases,
  reconcileOrphanExecutions,
  renewTaskLeases,
} from "./scheduler";
import { runWebhookRelayOnce } from "./webhook-relay";

/**
 * worker 进程入口（research.md §6 / FR-011）：
 * - 轮询领取到期任务+待领执行 → 有界并发执行；**执行与领取解耦**（单条长任务/流式不拖住调度）。
 * - 邮件/Webhook 中继走独立后台通道，不进领取关键路径。
 * - 执行期按心跳续租（长任务不丢租约）；孤儿执行对账（死 worker 的 running 整定，不清算停机错过的调度）。
 * - SIGTERM/SIGINT 优雅排空在途任务，超过宽限期强杀（abort 在途执行）。
 * - uncaughtException / unhandledRejection → 记录后非零退出（交进程管理器重启）。
 */

const workerId = `wk-${os.hostname()}-${process.pid}`;
const INTERVAL_MS = config.WORKER_POLL_INTERVAL_MS;
const LEASE_SECONDS = config.WORKER_LEASE_SECONDS;
const BATCH_SIZE = config.WORKER_BATCH_SIZE;

registerDefaultExecutors();

/** 进程级中止信号：shutdown 超过宽限后 abort，所有在途执行被取消。 */
const shutdownController = new AbortController();
const runner = createRunner(config.WORKER_MAX_CONCURRENCY, {
  abortSignal: shutdownController.signal,
});
let shuttingDown = false;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

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

    // 执行期续租：长任务不丢租约（只续自己认领的行，不影响主循环）
    const ids = [...runner.runningTaskIds];
    const renewed = await renewTaskLeases(ids, workerId, LEASE_SECONDS);
    if (ids.length > 0 && renewed < ids.length) {
      logger.warn(
        { expected: ids.length, renewed },
        "lease renewal missed some running tasks (reclaimed by another instance?)",
      );
    }

    // 孤儿对账：死 worker 遗留 running → failed（不重跑，防双副作用）；清过期认领
    await reconcileOrphanExecutions();

    // 历史坏账自愈：终态缺 outbox 行 → 幂等补插；慢通道 60s 一次，不跟每次心跳
    if (Date.now() - lastHealAt > HEAL_INTERVAL_MS) {
      lastHealAt = Date.now();
      try {
        const healed = await healMissingOutbox();
        if (healed > 0) {
          outboxHealedTotal.inc(healed);
          logger.warn({ healed }, "healed missing outbox rows");
        }
      } catch (error) {
        logger.warn({ err: (error as Error).message }, "heal missing outbox failed");
      }
    }

    // retention 归档：超期终态搬进 *_archive；慢通道 24h 一次（多 pod 各跑各的，分片幂等收敛）
    if (Date.now() - lastArchiveAt > ARCHIVE_INTERVAL_MS) {
      lastArchiveAt = Date.now();
      try {
        const summary = await runArchiveOnce();
        const total = summary.reduce((acc, s) => acc + s.moved, 0);
        if (total > 0) {
          logger.info({ summary }, "archived terminal rows");
        }
      } catch (error) {
        logger.warn({ err: (error as Error).message }, "archive run failed");
      }
    }
  } catch (error) {
    logger.warn({ err: (error as Error).message }, "heartbeat failed");
  }
}

/** 自愈节流：慢通道 60s 一次。 */
const HEAL_INTERVAL_MS = 60_000;
let lastHealAt = 0;

/** 归档节流：慢通道 24h 一次。 */
const ARCHIVE_INTERVAL_MS = 24 * 3600 * 1000;
let lastArchiveAt = 0;

/** 输出 outbox 待投递水位（中继通道内刷新）：pending=待投+在途，failed=等重试，dead=需手工 redrive。 */
const knownOutboxTenants = new Set<string>();
async function refreshOutboxGauge(): Promise<void> {
  try {
    const [emailGroups, webhookGroups, emailByTenant, webhookByTenant] = await Promise.all([
      prisma.emailLog.groupBy({ by: ["status"], _count: { status: true } }),
      prisma.webhookDelivery.groupBy({ by: ["status"], _count: { status: true } }),
      prisma.emailLog.groupBy({ by: ["tenantId", "status"], _count: { _all: true } }),
      prisma.webhookDelivery.groupBy({ by: ["tenantId", "status"], _count: { _all: true } }),
    ]);
    const sum = (groups: Array<{ status: string; _count: { status: number } }>, keys: string[]) =>
      groups
        .filter((g) => keys.includes(g.status))
        .reduce((acc, g) => acc + g._count.status, 0);
    outboxPending.set(
      sum(emailGroups, ["pending", "in_progress"]) + sum(webhookGroups, ["pending", "in_progress"]),
    );
    outboxFailed.set(sum(emailGroups, ["failed"]) + sum(webhookGroups, ["failed"]));
    outboxDead.set(sum(emailGroups, ["dead"]) + sum(webhookGroups, ["dead"]));
    // 分租户水位（公平 skew 信号，P1-3）：只留有积压的租户，排空的删 label 防残留
    const seen = new Set<string>();
    const pendingByTenant = new Map<string, number>();
    for (const g of [...emailByTenant, ...webhookByTenant]) {
      if (g.status === "pending" || g.status === "in_progress") {
        pendingByTenant.set(g.tenantId, (pendingByTenant.get(g.tenantId) ?? 0) + g._count._all);
      }
    }
    for (const [tenant, value] of pendingByTenant) {
      outboxPendingByTenant.set({ tenant }, value);
      seen.add(tenant);
      knownOutboxTenants.add(tenant);
    }
    for (const tenant of knownOutboxTenants) {
      if (!seen.has(tenant)) {
        outboxPendingByTenant.remove(tenant);
        knownOutboxTenants.delete(tenant);
      }
    }
  } catch {
    // 指标刷新失败不中断
  }
}

/**
 * 调度主循环：每轮只领取并发池还能接纳的量（freeSlots），提交后立即返回。
 * 不等待整批完成 → 单条长任务/流式只占自己的槽位，其他任务照常被领取执行。
 */
async function runLoop(): Promise<void> {
  while (!shuttingDown) {
    const started = Date.now();
    try {
      const free = runner.freeSlots;
      if (free > 0) {
        const claimed = await claimDueItems(workerId, LEASE_SECONDS, Math.min(BATCH_SIZE, free));
        if (claimed.length > 0) {
          runner.submit(claimed);
        }
      }
    } catch (error) {
      logger.error({ err: (error as Error).message }, "poll cycle failed (will retry)");
    }
    if (!shuttingDown) {
      await sleep(Math.max(100, INTERVAL_MS - (Date.now() - started)));
    }
  }
}

/** 中继后台通道：邮件 + Webhook 并行处理（与领取/执行解耦），独立节拍。 */
let currentRelayRound: Promise<void> | null = null;
async function relayLoop(): Promise<void> {
  while (!shuttingDown) {
    const started = Date.now();
    currentRelayRound = (async () => {
      try {
        void refreshOutboxGauge();
        await Promise.allSettled([
          runEmailRelayOnce(config.RELAY_BATCH_SIZE),
          runWebhookRelayOnce(config.RELAY_BATCH_SIZE),
        ]);
      } catch (error) {
        logger.error({ err: (error as Error).message }, "relay cycle failed (will retry)");
      }
    })();
    await currentRelayRound;
    currentRelayRound = null;
    if (!shuttingDown) {
      await sleep(Math.max(100, INTERVAL_MS - (Date.now() - started)));
    }
  }
}

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info({ signal }, "worker draining");
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  // 超过宽限仍未排空 → 强杀在途执行（abort 后执行器抛错、快速终态）
  const forceAbort = setTimeout(() => {
    logger.warn("drain grace exceeded; aborting in-flight tasks");
    shutdownController.abort();
  }, config.SHUTDOWN_GRACE_MS);
  await runner.drain(config.SHUTDOWN_GRACE_MS + 2000);
  // 排空中继在途轮次：已认领的 outbox 行落终态后再断连，否则变 in_progress 孤儿等 10 分钟回收
  const pendingRelay = currentRelayRound;
  if (pendingRelay) {
    let relayDone = false;
    await Promise.race([
      pendingRelay.then(() => {
        relayDone = true;
      }),
      sleep(Math.min(5000, config.SHUTDOWN_GRACE_MS)),
    ]);
    if (!relayDone) {
      logger.warn("relay drain timed out with round still in flight");
    }
  }
  clearTimeout(forceAbort);
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

for (const signal of ["SIGTERM", "SIGINT"] as NodeJS.Signals[]) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

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

  // 重启对账：停机期间错过的调度**不补跑**（仅推进 next_run_at）；回收过期租约；整定孤儿执行
  const advanced = await advanceMissedRuns();
  if (advanced > 0) {
    logger.info({ advanced }, "advanced missed runs after restart");
  }
  const reclaimed = await reclaimExpiredLeases();
  if (reclaimed > 0) {
    logger.info({ reclaimed }, "reclaimed expired leases");
  }
  const reconciled = await reconcileOrphanExecutions();
  if (reconciled > 0) {
    logger.info({ reconciled }, "reconciled orphan executions after restart");
  }

  void (heartbeatTimer = setInterval(() => void heartbeat(), Math.max(5000, INTERVAL_MS * 2)));
  await heartbeat();

  // 中继走独立后台通道，与领取解耦
  void relayLoop();
  await runLoop();
}

main().catch((error) => {
  logger.fatal({ err: error }, "worker main failed");
  process.exit(1);
});
