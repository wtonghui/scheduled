import { afterEach, describe, expect, it, vi } from "vitest";
import {
  classifyError,
  computeRetryDelayMs,
  jitteredDelayMs,
  retryWithJitter,
} from "../../src/lib/retry";
import { HttpError, TimeoutError } from "../../src/lib/errors";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("classifyError", () => {
  it("treats timeout and network errors as retryable", () => {
    expect(classifyError(new TimeoutError())).toBe("retryable");
    const network = Object.assign(new Error("reset"), { code: "ECONNRESET" });
    expect(classifyError(network)).toBe("retryable");
    const dns = Object.assign(new Error("dns"), { code: "EAI_AGAIN" });
    expect(classifyError(dns)).toBe("retryable");
  });

  it("classifies HTTP statuses", () => {
    expect(classifyError(new HttpError(500, "nope"))).toBe("retryable");
    expect(classifyError(new HttpError(429, "slow down"))).toBe("retryable");
    expect(classifyError(new HttpError(404, "missing"))).toBe("permanent");
    expect(classifyError(new HttpError(400, "bad"))).toBe("permanent");
    expect(classifyError({ status: 503 } as Error)).toBe("retryable");
    expect(classifyError({ status: 422 } as Error)).toBe("permanent");
  });

  it("classifies SMTP response codes (P0-1)", () => {
    // 4xx 瞬断（灰名单/限流）→ 重试；5xx（收件人不存在）→ 永久
    const grey = Object.assign(new Error("greylisted"), {
      code: "EENVELOPE",
      responseCode: 451,
    });
    expect(classifyError(grey)).toBe("retryable");
    const refused = Object.assign(new Error("mailbox unavailable"), {
      code: "EENVELOPE",
      responseCode: 550,
    });
    expect(classifyError(refused)).toBe("permanent");
    // nodemailer 连接层错误 → 重试
    expect(classifyError(Object.assign(new Error("socket"), { code: "ESOCKET" }))).toBe(
      "retryable",
    );
    expect(classifyError(Object.assign(new Error("conn"), { code: "ECONNECTION" }))).toBe(
      "retryable",
    );
  });

  it("treats prisma P2034 as retryable", () => {
    expect(classifyError(Object.assign(new Error("deadlock"), { code: "P2034" }))).toBe(
      "retryable",
    );
  });

  it("treats program bugs as permanent", () => {
    expect(classifyError(new TypeError("bad"))).toBe("permanent");
    expect(classifyError(new Error("unknown"))).toBe("permanent");
  });
});

describe("jitteredDelayMs", () => {
  it("bounds delay by capMs", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(jitteredDelayMs(1000, 2, 30000, 10)).toBe(30000);
  });

  it("grows exponentially with attempt index", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(jitteredDelayMs(1000, 2, 30000, 0)).toBe(1000);
    expect(jitteredDelayMs(1000, 2, 30000, 1)).toBe(2000);
    expect(jitteredDelayMs(1000, 2, 30000, 2)).toBe(4000);
  });

  it("handles random=0 as zero delay", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    expect(jitteredDelayMs(1000, 2, 30000, 3)).toBe(0);
  });
});

describe("computeRetryDelayMs", () => {
  it("keeps 30s cap for default base (legacy behavior)", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(computeRetryDelayMs(1000, 0)).toBe(1000);
    expect(computeRetryDelayMs(1000, 1)).toBe(2000);
    expect(computeRetryDelayMs(1000, 10)).toBe(30000);
  });

  it("lets custom base through (no 30s clamp)", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(computeRetryDelayMs(300000, 0)).toBe(300000);
    expect(computeRetryDelayMs(300000, 1)).toBe(300000);
    expect(computeRetryDelayMs(300000, 5)).toBe(300000);
  });

  it("base 0 means immediate retry", () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    expect(computeRetryDelayMs(0, 0)).toBe(0);
  });
});

describe("retryWithJitter", () => {
  it("returns success on the first attempt", async () => {
    const fn = vi.fn(async () => "ok");
    await expect(retryWithJitter({ attempts: 3, fn })).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until success", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // no real delay
    let calls = 0;
    const fn = vi.fn(async () => {
      calls += 1;
      if (calls < 3) {
        throw new HttpError(503, "server error");
      }
      return "recovered";
    });
    await expect(retryWithJitter({ attempts: 5, fn })).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("stops retrying on a permanent error", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fn = vi.fn(async () => {
      throw new HttpError(404, "missing");
    });
    await expect(retryWithJitter({ attempts: 5, fn })).rejects.toThrow("missing");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("exhausts attempts and rethrows the last error", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const fn = vi.fn(async () => {
      throw new HttpError(500, "still failing");
    });
    await expect(retryWithJitter({ attempts: 3, fn })).rejects.toBeInstanceOf(HttpError);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("reports onRetry with a computed delay", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const retries: Array<{ error: unknown; attempt: number; delayMs: number }> = [];
    const fn = vi.fn<(attempt: number) => Promise<unknown>>().mockImplementation(async () => {
      throw Object.assign(new Error("transient"), { code: "ECONNRESET" });
    });
    await retryWithJitter({
      attempts: 3,
      fn,
      baseMs: 100,
      factor: 2,
      capMs: 1000,
      onRetry: (error, attempt, delayMs) => retries.push({ error, attempt, delayMs }),
    }).catch(() => {});
    expect(retries).toHaveLength(2);
    // attempt 1 -> 0.5 * 100 = 50ms; attempt 2 -> 0.5 * 200 = 100ms
    expect(retries[0]?.delayMs).toBe(50);
    expect(retries[1]?.delayMs).toBe(100);
  });
});
