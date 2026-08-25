import { describe, expect, it } from "vitest";
import {
  type ScheduleSpec,
  buildSchedule,
  defaultSpec,
  describeSpec,
  nextRunPreview,
  parseCronToSpec,
  parseNaturalLanguage,
} from "../../src/lib/schedule-builder";

/** 测试内收窄：无需非空断言（相比 `!`，直接判空更明确）。 */
function must<T>(value: T | null | undefined): T {
  if (value === null || value === undefined) {
    throw new Error("expected non-null value in test");
  }
  return value;
}

describe("buildSchedule", () => {
  it("minute → */N * * * *", () => {
    const spec: ScheduleSpec = { ...defaultSpec(), mode: "minute", minuteInterval: 10 };
    expect(buildSchedule(spec)).toEqual({ cron: "*/10 * * * *" });
  });

  it("hour with minute offset → M */N * * *", () => {
    const spec: ScheduleSpec = {
      ...defaultSpec(),
      mode: "hour",
      hourInterval: 3,
      minuteOfHour: 15,
    };
    expect(buildSchedule(spec)).toEqual({ cron: "15 */3 * * *" });
  });

  it("day → M H * * *", () => {
    const spec: ScheduleSpec = {
      ...defaultSpec(),
      mode: "day",
      hourOfDay: 3,
      minuteOfHour: 0,
    };
    expect(buildSchedule(spec)).toEqual({ cron: "0 3 * * *" });
  });

  it("weekday → M H * * 1-5", () => {
    const spec: ScheduleSpec = {
      ...defaultSpec(),
      mode: "weekday",
      hourOfDay: 9,
      minuteOfHour: 30,
    };
    expect(buildSchedule(spec)).toEqual({ cron: "30 9 * * 1-5" });
  });

  it("week → M H * * sorted DOW list", () => {
    const spec: ScheduleSpec = {
      ...defaultSpec(),
      mode: "week",
      weekDays: [5, 1],
      hourOfDay: 9,
      minuteOfHour: 0,
    };
    expect(buildSchedule(spec)).toEqual({ cron: "0 9 * * 1,5" });
  });

  it("week with empty weekDays → null", () => {
    const spec: ScheduleSpec = { ...defaultSpec(), mode: "week", weekDays: [] };
    expect(buildSchedule(spec)).toBeNull();
  });

  it("month → M H D * *", () => {
    const spec: ScheduleSpec = {
      ...defaultSpec(),
      mode: "month",
      dayOfMonth: 1,
      hourOfDay: 0,
      minuteOfHour: 0,
    };
    expect(buildSchedule(spec)).toEqual({ cron: "0 0 1 * *" });
  });

  it("interval → cron day-of-month step", () => {
    const spec: ScheduleSpec = {
      ...defaultSpec(),
      mode: "interval",
      dayInterval: 3,
      hourOfDay: 9,
      minuteOfHour: 30,
    };
    expect(buildSchedule(spec)).toEqual({ cron: "30 9 */3 * *" });
  });

  it("clamps out-of-range hour", () => {
    const spec: ScheduleSpec = { ...defaultSpec(), mode: "day", hourOfDay: 25 };
    expect(buildSchedule(spec)).toEqual({ cron: "0 23 * * *" });
  });
});

describe("describeSpec", () => {
  it("renders Chinese label", () => {
    expect(describeSpec({ ...defaultSpec(), mode: "day", hourOfDay: 3 })).toBe("每天 03:00");
    expect(describeSpec({ ...defaultSpec(), mode: "weekday", hourOfDay: 9 })).toBe("工作日 09:00");
    expect(describeSpec({ ...defaultSpec(), mode: "week", weekDays: [1, 3] })).toBe(
      "每周周一、周三 00:00",
    );
  });
});

describe("parseNaturalLanguage", () => {
  it("每天凌晨3点 → day 03:00", () => {
    const spec = parseNaturalLanguage("每天凌晨3点");
    expect(spec?.mode).toBe("day");
    expect(spec?.hourOfDay).toBe(3);
    expect(spec?.minuteOfHour).toBe(0);
    expect(buildSchedule(must(spec))).toEqual({ cron: "0 3 * * *" });
  });

  it("工作日上午9点 → weekday 09:00", () => {
    const spec = parseNaturalLanguage("工作日上午9点");
    expect(spec?.mode).toBe("weekday");
    expect(spec?.hourOfDay).toBe(9);
  });

  it("每天晚上8点半 → day 20:30", () => {
    const spec = parseNaturalLanguage("每天晚上8点半");
    expect(spec?.mode).toBe("day");
    expect(spec?.hourOfDay).toBe(20);
    expect(spec?.minuteOfHour).toBe(30);
  });

  it("每周一早上8点 → week [1] 08:00", () => {
    const spec = parseNaturalLanguage("每周一早上8点");
    expect(spec?.mode).toBe("week");
    expect(spec?.weekDays).toEqual([1]);
    expect(spec?.hourOfDay).toBe(8);
  });

  it("每月15号凌晨2点 → month day=15 02:00", () => {
    const spec = parseNaturalLanguage("每月15号凌晨2点");
    expect(spec?.mode).toBe("month");
    expect(spec?.dayOfMonth).toBe(15);
    expect(spec?.hourOfDay).toBe(2);
  });

  it("每10分钟 → minute", () => {
    const spec = parseNaturalLanguage("每10分钟");
    expect(spec?.mode).toBe("minute");
    expect(spec?.minuteInterval).toBe(10);
  });

  it("每3天 → interval，默认 00:00", () => {
    const spec = parseNaturalLanguage("每3天");
    expect(spec?.mode).toBe("interval");
    expect(spec?.dayInterval).toBe(3);
    expect(buildSchedule(must(spec))).toEqual({ cron: "0 0 */3 * *" });
  });

  it("garbage → null", () => {
    expect(parseNaturalLanguage("完全乱写的东西")).toBeNull();
    expect(parseNaturalLanguage("")).toBeNull();
  });
});

describe("parseCronToSpec", () => {
  it("minute*/N → minute", () => {
    expect(parseCronToSpec("*/10 * * * *")).toMatchObject({ mode: "minute", minuteInterval: 10 });
  });

  it("`* * * * *`（分字段 `*`）→ minute 1", () => {
    expect(parseCronToSpec("* * * * *")).toMatchObject({ mode: "minute", minuteInterval: 1 });
  });

  it("hour with minute offset → hour", () => {
    expect(parseCronToSpec("15 */3 * * *")).toMatchObject({
      mode: "hour",
      hourInterval: 3,
      minuteOfHour: 15,
    });
  });

  it("day → day", () => {
    expect(parseCronToSpec("30 8 * * *")).toMatchObject({
      mode: "day",
      hourOfDay: 8,
      minuteOfHour: 30,
    });
  });

  it("weekday 1-5 → weekday", () => {
    expect(parseCronToSpec("0 9 * * 1-5")).toMatchObject({ mode: "weekday", hourOfDay: 9 });
  });

  it("week DOW list → week (排序去重)", () => {
    expect(parseCronToSpec("5 10 * * 2,1")).toMatchObject({
      mode: "week",
      weekDays: [1, 2],
      hourOfDay: 10,
      minuteOfHour: 5,
    });
    expect(parseCronToSpec("5 10 * * 4-6")).toMatchObject({ weekDays: [4, 5, 6] });
  });

  it("month → month", () => {
    expect(parseCronToSpec("0 3 15 * *")).toMatchObject({
      mode: "month",
      dayOfMonth: 15,
      hourOfDay: 3,
    });
  });

  it("interval */N in day-of-month → interval", () => {
    expect(parseCronToSpec("0 6 */2 * *")).toMatchObject({ mode: "interval", dayInterval: 2 });
  });

  it("round-trips every structured mode", () => {
    const cases: Array<Partial<ScheduleSpec> & { mode: ScheduleSpec["mode"] }> = [
      { mode: "minute", minuteInterval: 5 },
      { mode: "hour", hourInterval: 3, minuteOfHour: 15 },
      { mode: "day", hourOfDay: 8, minuteOfHour: 30 },
      { mode: "weekday", hourOfDay: 9, minuteOfHour: 0 },
      { mode: "week", weekDays: [1, 3], hourOfDay: 10, minuteOfHour: 5 },
      { mode: "month", dayOfMonth: 15, hourOfDay: 3, minuteOfHour: 0 },
      { mode: "interval", dayInterval: 2, hourOfDay: 6, minuteOfHour: 0 },
    ];
    for (const patch of cases) {
      const spec = { ...defaultSpec(), ...patch };
      const built = must(buildSchedule(spec));
      const cron = must(built.cron);
      expect(parseCronToSpec(cron)).toEqual(spec);
    }
  });

  it("unexpressible cron → null（6 段、月限制、日期+星期组合）", () => {
    expect(parseCronToSpec("0 0 * * * *")).toBeNull();
    expect(parseCronToSpec("0 0 * 2 *")).toBeNull();
    expect(parseCronToSpec("0 9 15 * 1-5")).toBeNull();
    expect(parseCronToSpec("")).toBeNull();
  });
});

describe("nextRunPreview", () => {
  it("returns a future date for a daily schedule (显式 UTC)", () => {
    const from = new Date("2026-08-21T00:00:00.000Z");
    const next = nextRunPreview({ ...defaultSpec(), mode: "day", hourOfDay: 3 }, from, "Etc/UTC");
    expect(next).not.toBeNull();
    expect(must(next).getTime()).toBeGreaterThan(from.getTime());
    expect(must(next).toISOString()).toBe("2026-08-21T03:00:00.000Z");
  });

  it("returns null for an invalid spec", () => {
    expect(nextRunPreview({ ...defaultSpec(), mode: "week", weekDays: [] })).toBeNull();
  });
});
