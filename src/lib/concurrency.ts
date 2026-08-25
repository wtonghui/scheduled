import pLimit from "p-limit";
import { TimeoutError } from "./errors";

/**
 * 有界异步并发池（p-limit）＋ 带超时执行（AbortController）。
 * research.md §3：Node 中"协程"的等价物。
 */

export interface Pool {
  readonly concurrency: number;
  readonly activeCount: number;
  readonly pendingCount: number;
  run<T>(fn: () => Promise<T>): Promise<T>;
}

export function createPool(concurrency: number): Pool {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`concurrency must be a positive integer, got ${concurrency}`);
  }
  const limit = pLimit(concurrency);
  return {
    concurrency,
    get activeCount() {
      return limit.activeCount;
    },
    get pendingCount() {
      return limit.pendingCount;
    },
    run<T>(fn: () => Promise<T>): Promise<T> {
      return limit(fn);
    },
  };
}

/**
 * 在 `ms` 毫秒内完成则返回结果，否则 abort 并抛 TimeoutError。
 * fn 收到的 AbortSignal 已达线到 fetch(signal)/其他可取消源。
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  ms: number,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`timeout must be a positive number, got ${ms}`);
  }
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      controller.abort();
      reject(new TimeoutError(`timed out after ${ms}ms`));
    }, ms);

    fn(controller.signal).then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}