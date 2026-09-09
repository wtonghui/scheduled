import { describe, expect, it, vi } from "vitest";
import { createPool, withTimeout } from "../../src/lib/concurrency";
import { TimeoutError } from "../../src/lib/errors";

describe("createPool", () => {
  it("rejects invalid concurrency", () => {
    expect(() => createPool(0)).toThrow();
    expect(() => createPool(1.5)).toThrow();
  });

  it("bounds concurrent execution", async () => {
    const pool = createPool(2);
    let running = 0;
    let peak = 0;

    const jobs = Array.from({ length: 8 }, () =>
      pool.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 20));
        running -= 1;
      }),
    );

    await Promise.all(jobs);
    expect(peak).toBeLessThanOrEqual(2);
    expect(pool.activeCount).toBe(0);
    expect(pool.pendingCount).toBe(0);
  });

  it("queues excess work", async () => {
    const pool = createPool(1);
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });

    const first = pool.run(() => gate);
    const second = pool.run(async () => "second");

    await new Promise((r) => setTimeout(r, 10));
    expect(pool.activeCount).toBe(1);
    expect(pool.pendingCount).toBe(1);

    release();
    await first;
    await expect(second).resolves.toBe("second");
  });
});

describe("withTimeout", () => {
  it("resolves when fn completes in time", async () => {
    await expect(withTimeout(async () => "done", 1000)).resolves.toBe("done");
  });

  it("rejects with TimeoutError when fn exceeds the deadline", async () => {
    await expect(
      withTimeout(async () => {
        await new Promise((r) => setTimeout(r, 500));
        return "too slow";
      }, 50),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("aborts the signal on timeout", async () => {
    let aborted = false;
    await expect(
      withTimeout(
        (signal) =>
          new Promise<string>((_resolve, reject) => {
            signal.addEventListener("abort", () => {
              aborted = true;
              reject(signal.reason);
            });
          }),
        30,
      ),
    ).rejects.toThrow();
    expect(aborted).toBe(true);
  });

  it("rejects with the fn's own error when it fails fast", async () => {
    await expect(
      withTimeout(async () => {
        throw new Error("boom");
      }, 1000),
    ).rejects.toThrow("boom");
  });

  it("keeps alive while fn reports progress beyond the nominal deadline (idle timeout)", async () => {
    // 总耗时 5×60ms=300ms > 100ms，但每步都续命 → 应 resolve
    await expect(
      withTimeout(async (_signal, onProgress) => {
        for (let i = 0; i < 5; i += 1) {
          await new Promise((r) => setTimeout(r, 60));
          onProgress?.();
        }
        return "streamed done";
      }, 100),
    ).resolves.toBe("streamed done");
  });

  it("times out when fn stalls without progress for the idle window", async () => {
    // 续命两次后停摆，无进展超过 50ms → TimeoutError
    await expect(
      withTimeout(async (_signal, onProgress) => {
        onProgress?.();
        await new Promise((r) => setTimeout(r, 30));
        onProgress?.();
        await new Promise((r) => setTimeout(r, 300)); // 停摆
        return "too late";
      }, 50),
    ).rejects.toBeInstanceOf(TimeoutError);
  });

  it("aborts and rejects when the external signal fires (shutdown force-kill)", async () => {
    const controller = new AbortController();
    const p = withTimeout(
      () => new Promise<never>(() => {}), // 永不完成；只有外部信号能终止
      10_000,
      controller.signal,
    );
    controller.abort();
    await expect(p).rejects.toThrow(/external signal/);
  });

  it("rejects immediately when the external signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(withTimeout(async () => "done", 1000, controller.signal)).rejects.toThrow(
      /external signal/,
    );
  });
});
