import { describe, expect, it } from "vitest";
import { computeNextRun, isValidCron, isValidSchedule, nextRunAt } from "../../src/lib/cron";

describe("isValidCron", () => {
  it("accepts standard 5-field expressions", () => {
    expect(isValidCron("* * * * *")).toBe(true);
    expect(isValidCron("*/5 * * * *")).toBe(true);
    expect(isValidCron("0 0 * * *")).toBe(true);
    expect(isValidCron("0 0 1 1 *")).toBe(true);
  });

  it("accepts 6-field expressions with seconds", () => {
    expect(isValidCron("*/10 * * * * *")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidCron("not a cron")).toBe(false);
    expect(isValidCron("")).toBe(false);
    expect(isValidCron("60 * * * *")).toBe(false); // minute > 59
    expect(isValidCron("* * *")).toBe(false);
  });

  it("accepts 7-field Quartz expressions with year", () => {
    expect(isValidCron("0 0 9 1 1 * 2027")).toBe(true);
    expect(isValidCron("0 0 9 1 1 * 2027-2029")).toBe(true);
    expect(isValidCron("0 0 9 1 1 * *")).toBe(true);
  });

  it("rejects bad 7-field expressions", () => {
    expect(isValidCron("0 0 9 1 1 * 2027 8")).toBe(false); // 8 段
    expect(isValidCron("60 0 9 1 1 * 2027")).toBe(false); // 秒 > 59
    expect(isValidCron("0 0 9 1 1 * abcd")).toBe(false); // 年非数字
  });
});

describe("nextRunAt", () => {
  const from = new Date("2026-08-20T12:00:00.000Z");

  it("computes the next occurrence after `from`", () => {
    const next = nextRunAt("*/5 * * * *", from);
    expect(next).not.toBeNull();
    expect(next?.getTime()).toBeGreaterThan(from.getTime());
    expect(next?.toISOString()).toBe("2026-08-20T12:05:00.000Z");
  });

  it("is deterministic for the same input (显式 UTC 网格语义)", () => {
    expect(nextRunAt("0 0 * * *", from, "Etc/UTC")?.toISOString()).toBe("2026-08-21T00:00:00.000Z");
  });

  it("defaults to Asia/Shanghai", () => {
    // from = 08-20 12:00Z = 20:00 +08;上海次日 00:00 = 08-20 16:00Z
    expect(nextRunAt("0 0 * * *", from)?.toISOString()).toBe("2026-08-20T16:00:00.000Z");
    // 默认时区与显式 UTC 必须给出不同时刻,证明默认已切中国时区
    expect(nextRunAt("0 0 * * *", from)?.toISOString()).not.toBe(
      nextRunAt("0 0 * * *", from, "Etc/UTC")?.toISOString(),
    );
  });

  it("returns null when no future run exists", () => {
    // 每年 2 月 30 日不存在 → 无下一个发生
    expect(nextRunAt("0 0 30 2 *", from)).toBeNull();
  });

  it("supports 7-field year: next run lands in the specified year", () => {
    // 2027-01-01 09:00 +08 = 2027-01-01T01:00:00Z
    expect(nextRunAt("0 0 9 1 1 * 2027", from)?.toISOString()).toBe("2027-01-01T01:00:00.000Z");
  });

  it("supports 7-field year ranges", () => {
    expect(nextRunAt("0 0 9 1 1 * 2027-2029", from)?.toISOString()).toBe(
      "2027-01-01T01:00:00.000Z",
    );
  });

  it("returns null for a past year (→ 创建时 400 / 跑后自动停用)", () => {
    expect(nextRunAt("0 0 9 1 1 * 2020", from)).toBeNull();
  });

  it("returns null for impossible date with year", () => {
    expect(nextRunAt("0 0 0 30 2 * 2027", from)).toBeNull();
  });
});

describe("isValidSchedule", () => {
  it("requires exactly one of cron/interval", () => {
    expect(isValidSchedule({ cron: "* * * * *" })).toBe(true);
    expect(isValidSchedule({ scheduleIntervalSeconds: 300 })).toBe(true);
    expect(isValidSchedule({})).toBe(false);
    expect(isValidSchedule({ cron: "* * * * *", scheduleIntervalSeconds: 300 })).toBe(false);
  });

  it("rejects zero/negative intervals", () => {
    expect(isValidSchedule({ scheduleIntervalSeconds: 0 })).toBe(false);
    expect(isValidSchedule({ scheduleIntervalSeconds: -5 })).toBe(false);
  });
});

describe("computeNextRun", () => {
  const from = new Date("2026-08-20T12:00:00.000Z");

  it("proxies cron scheduling", () => {
    expect(computeNextRun({ cron: "* * * * *" }, from)?.toISOString()).toBe(
      "2026-08-20T12:01:00.000Z",
    );
  });

  it("advances fixed interval by seconds", () => {
    expect(computeNextRun({ scheduleIntervalSeconds: 300 }, from)?.toISOString()).toBe(
      "2026-08-20T12:05:00.000Z",
    );
  });

  it("returns null with no schedule", () => {
    expect(computeNextRun({}, from)).toBeNull();
  });
});
