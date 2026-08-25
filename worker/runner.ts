import { createPool, type Pool } from "../src/lib/concurrency";
import { runTaskWithScheduledAt } from "../src/modules/execution/service";
import { logger } from "../src/lib/logger";
import type { ClaimItem } from "./scheduler";

/**
 * 有界异步并发运行器（research.md §3 / FR-004）：
 * - p-limit 池限并发；Promise.allSettled 单任务失败不中断批次。
 * - 跟踪在途任务，供优雅关停排空。
 */

export interface Runner {
  readonly pool: Pool;
  readonly inFlightCount: number;
  runAll(items: ClaimItem[]): Promise<void>;
  drain(timeoutMs: number): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRunner(maxConcurrency: number): Runner {
  const pool = createPool(maxConcurrency);
  const inFlight = new Set<Promise<unknown>>();

  return {
    pool,
    get inFlightCount() {
      return inFlight.size;
    },
    async runAll(items: ClaimItem[]): Promise<void> {
      const results = await Promise.allSettled(
        items.map((item) => {
          const p =
            item.kind === "manual"
              ? pool.run(() =>
                  runTaskWithScheduledAt(item.task, item.scheduledAt, "manual", {
                    executionId: item.executionId,
                  }),
                )
              : pool.run(() =>
                  runTaskWithScheduledAt(item.task, item.scheduledAt, "scheduled"),
                );
          inFlight.add(p);
          void p.finally(() => {
            inFlight.delete(p);
          });
          return p;
        }),
      );
      let ok = 0;
      let failed = 0;
      for (const result of results) {
        if (result.status === "fulfilled") {
          ok += 1;
        } else {
          failed += 1;
        }
      }
      logger.info({ batch: items.length, ok, failed }, "worker batch finished");
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