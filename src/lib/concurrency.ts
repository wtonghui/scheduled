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
 * 在 `ms` 毫秒内完成则返回结果，否则 abort 并抛 TimeoutError；可选外部信号强制中止（如进程关停）。
 * fn 收到的 AbortSignal 已达线到 fetch(signal)/其他可取消源。
 *
 * fn 可接收第二个参数 `onProgress`：在取得进展时调用（如流式响应收到一个 chunk），
 * 会**重置空闲计时器**——此时语义变为「连续 ms 无进展才超时」，长流不再被总时长误杀。
 * 不调用 onProgress 时语义不变（从启动起 ms 后超时）。
 * `externalSignal`：中止时立即 abort 内部 controller 并以通用错误 reject（如 worker 优雅关停超时的强杀）。
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal, onProgress?: () => void) => Promise<T>,
  ms: number,
  externalSignal?: AbortSignal,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error(`timeout must be a positive number, got ${ms}`);
  }
  const controller = new AbortController();

  return new Promise<T>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const cleanup = (): void => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      externalSignal?.removeEventListener("abort", onExternalAbort);
    };

    const arm = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        controller.abort();
        reject(new TimeoutError(`timed out after ${ms}ms`));
      }, ms);
    };

    const onProgress = (): void => arm();

    const onExternalAbort = (): void => {
      controller.abort();
      reject(new Error("aborted by external signal"));
    };

    if (externalSignal) {
      if (externalSignal.aborted) {
        onExternalAbort();
        return;
      }
      externalSignal.addEventListener("abort", onExternalAbort, { once: true });
    }

    arm();
    fn(controller.signal, onProgress).then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      },
    );
  });
}
