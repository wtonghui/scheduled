import { type Pool, createPool } from "../src/lib/concurrency";
import { logger } from "../src/lib/logger";
import { runTaskWithScheduledAt } from "../src/modules/execution/service";
import type { ClaimItem } from "./scheduler";

/**
 * 有界异步并发运行器（research.md §3 / FR-004）：
 * - p-limit 池限并发；`submit` 只入池不等待——调度循环不被单条长任务（含流式）拖住。
 * - 领取方按 `freeSlots` 控制每次提交量：排队任务不会超过池容量，免租约排队过期被重复领取。
 * - 追踪运行中任务 id（`runningTaskIds`）供执行期租约续期（长任务不被别实例重领双跑）。
 * - `drain` 供优雅关停排空在途任务。
 */

export interface Runner {
  readonly pool: Pool;
  readonly inFlightCount: number;
  /** 池还可接纳的任务数 = concurrency - active - pending。 */
  readonly freeSlots: number;
  /** 当前执行中任务的 task.id 集合（租约续期用；有新提交即入列、跑完即移除）。 */
  readonly runningTaskIds: ReadonlySet<string>;
  /** 把一批任务提交进并发池，立即返回（不等待完成）。 */
  submit(items: ClaimItem[]): void;
  /** 等所有在途任务结束（超时打 warn）。 */
  drain(timeoutMs: number): Promise<void>;
}

export interface RunnerOptions {
  /** 进程级中止信号：触发时所有在途执行被 abort（shutdown 超时强杀）。 */
  abortSignal?: AbortSignal;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRunner(maxConcurrency: number, options: RunnerOptions = {}): Runner {
  const pool = createPool(maxConcurrency);
  const inFlight = new Set<Promise<unknown>>();
  const runningTaskIds = new Set<string>();
  const { abortSignal } = options;

  return {
    pool,
    get inFlightCount() {
      return inFlight.size;
    },
    get freeSlots() {
      return Math.max(0, maxConcurrency - pool.activeCount - pool.pendingCount);
    },
    get runningTaskIds() {
      return runningTaskIds;
    },
    submit(items: ClaimItem[]): void {
      const tracked: Promise<unknown>[] = [];
      for (const item of items) {
        const p =
          item.kind === "manual"
            ? pool.run(() =>
                runTaskWithScheduledAt(item.task, item.scheduledAt, "manual", {
                  executionId: item.executionId,
                  externalSignal: abortSignal,
                }),
              )
            : pool.run(() =>
                runTaskWithScheduledAt(item.task, item.scheduledAt, "scheduled", {
                  externalSignal: abortSignal,
                }),
              );
        tracked.push(p);
        runningTaskIds.add(item.task.id);
        inFlight.add(p);
        void p
          .catch(() => {
            /* 单任务失败由 runTaskWithScheduledAt 兜成 RunOutcome；此处消化以防 unhandled */
          })
          .finally(() => {
            inFlight.delete(p);
            runningTaskIds.delete(item.task.id);
          });
      }
      // 批次汇总日志：后台结算，不阻塞调度循环
      void Promise.allSettled(tracked).then((results) => {
        const ok = results.filter((r) => r.status === "fulfilled").length;
        logger.info(
          { batch: tracked.length, ok, failed: tracked.length - ok },
          "worker batch finished",
        );
      });
    },
    async drain(timeoutMs: number): Promise<void> {
      const deadline = Date.now() + timeoutMs;
      while (inFlight.size > 0 && Date.now() < deadline) {
        await sleep(100);
      }
      if (inFlight.size > 0) {
        logger.warn({ remaining: inFlight.size }, "drain timed out with tasks still in flight");
      }
    },
  };
}
