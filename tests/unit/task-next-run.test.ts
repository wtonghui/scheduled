import { describe, expect, it } from "vitest";
import {
  computeUpcomingRuns,
  previewSpecNextRuns,
  type UpcomingSpec,
} from "../../src/modules/task/service";

/** 下次运行预览：与 claim 同语义，假日函数全注入，零 DB、零网络、确定性。 */

const BASE: UpcomingSpec = {
  cron: null,
  scheduleIntervalSeconds: null,
  timezone: "Asia/Shanghai",
  startsAt: null,
  endsAt: null,
  maxRuns: null,
  consumedRuns: 0,
  skipHolidays: false,
  holidayPolicy: "drop",
};

const workday = async () => false;

describe("computeUpcomingRuns", () => {
  it("returns the next cron tick from `from`", async () => {
    const { runs, stopped } = await computeUpcomingRuns(
      { ...BASE, cron: "0 9 * * *" },
      { from: new Date("2026-09-14T08:00:00.000+08:00"), count: 2, isHolidayFn: workday },
    );
    expect(stopped).toBeNull();
    expect(runs).toHaveLength(2);
    expect(runs[0]?.scheduledAt.toISOString()).toBe("2026-09-14T01:00:00.000Z");
    expect(runs[0]?.holidayAdjusted).toBe(false);
    expect(runs[1]?.scheduledAt.toISOString()).toBe("2026-09-15T01:00:00.000Z");
  });

  it("drop policy skips the holiday tick", async () => {
    const isHoliday = async (day: string) => day === "20260914";
    const { runs } = await computeUpcomingRuns(
      { ...BASE, cron: "0 * * * *", skipHolidays: true, holidayPolicy: "drop" },
      { from: new Date("2026-09-14T08:30:00.000+08:00"), count: 1, isHolidayFn: isHoliday },
    );
    // 9 月 14 日全天是假日 → 作废，取下一个调度点（次日 00:00）
    expect(runs[0]?.scheduledAt.toISOString()).toBe("2026-09-14T16:00:00.000Z");
    expect(runs[0]?.holidayAdjusted).toBe(true);
  });

  it("drop policy skips a single holiday tick for daily cron", async () => {
    const isHoliday = async (day: string) => day === "20260914";
    const { runs } = await computeUpcomingRuns(
      { ...BASE, cron: "0 9 * * *", skipHolidays: true, holidayPolicy: "drop" },
      { from: new Date("2026-09-14T08:00:00.000+08:00"), count: 1, isHolidayFn: isHoliday },
    );
    // 当天 09:00 是假日 → 作废，下一调度点是次日 09:00
    expect(runs[0]?.scheduledAt.toISOString()).toBe("2026-09-15T01:00:00.000Z");
    expect(runs[0]?.holidayAdjusted).toBe(true);
  });

  it("postpone policy shifts to the next workday same wall-clock", async () => {
    const isHoliday = async (day: string) => day === "20260914";
    const { runs } = await computeUpcomingRuns(
      { ...BASE, cron: "0 * * * *", skipHolidays: true, holidayPolicy: "postpone" },
      { from: new Date("2026-09-14T08:30:00.000+08:00"), count: 1, isHolidayFn: isHoliday },
    );
    // 09:00 是假日 → 顺延到次日同一墙钟 09:00（+08:00）
    expect(runs[0]?.scheduledAt.toISOString()).toBe("2026-09-15T01:00:00.000Z");
    expect(runs[0]?.holidayAdjusted).toBe(true);
  });

  it("future startsAt defers the first run", async () => {
    const { runs } = await computeUpcomingRuns(
      {
        ...BASE,
        cron: "0 9 * * *",
        startsAt: new Date("2026-09-16T00:00:00.000+08:00"),
      },
      { from: new Date("2026-09-14T08:00:00.000+08:00"), count: 1, isHolidayFn: workday },
    );
    expect(runs[0]?.scheduledAt.toISOString()).toBe("2026-09-16T01:00:00.000Z");
  });

  it("stops at endsAt without emitting past-window runs", async () => {
    const { runs, stopped } = await computeUpcomingRuns(
      {
        ...BASE,
        cron: "0 9 * * *",
        endsAt: new Date("2026-09-14T10:00:00.000+08:00"),
      },
      { from: new Date("2026-09-14T08:00:00.000+08:00"), count: 3, isHolidayFn: workday },
    );
    expect(runs).toHaveLength(1);
    expect(stopped).toBe("endsAt");
  });

  it("stops at maxRuns (quota from consumedRuns)", async () => {
    const full = await computeUpcomingRuns(
      { ...BASE, cron: "0 9 * * *", maxRuns: 10, consumedRuns: 10 },
      { from: new Date("2026-09-14T08:00:00.000+08:00"), count: 3, isHolidayFn: workday },
    );
    expect(full.runs).toHaveLength(0);
    expect(full.stopped).toBe("maxRuns");

    const last = await computeUpcomingRuns(
      { ...BASE, cron: "0 9 * * *", maxRuns: 10, consumedRuns: 9 },
      { from: new Date("2026-09-14T08:00:00.000+08:00"), count: 3, isHolidayFn: workday },
    );
    expect(last.runs).toHaveLength(1);
    expect(last.stopped).toBe("maxRuns");
  });

  it("reports no-future-schedule without cron or interval", async () => {
    const { runs, stopped } = await computeUpcomingRuns(
      BASE,
      { from: new Date("2026-09-14T08:00:00.000+08:00"), count: 1, isHolidayFn: workday },
    );
    expect(runs).toHaveLength(0);
    expect(stopped).toBe("no-future-schedule");
  });

  it("estimates interval runs from the cursor", async () => {
    const from = new Date("2026-09-14T08:00:00.000+08:00");
    const { runs, stopped } = await computeUpcomingRuns(
      { ...BASE, scheduleIntervalSeconds: 3600 },
      { from, count: 2, isHolidayFn: workday },
    );
    expect(stopped).toBeNull();
    expect(runs[0]?.scheduledAt.getTime()).toBe(from.getTime() + 3600_000);
    expect(runs[1]?.scheduledAt.getTime()).toBe(from.getTime() + 2 * 3600_000);
  });
});

describe("previewSpecNextRuns runAt", () => {
  const FUTURE = "2099-01-01T10:00:00.000+08:00";

  it("returns the single run plus terminal stopped", async () => {
    const out = await previewSpecNextRuns({ runAt: FUTURE, count: 5 });
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]?.scheduledAt.toISOString()).toBe("2099-01-01T02:00:00.000Z");
    expect(out.runs[0]?.holidayAdjusted).toBe(false);
    expect(out.stopped).toBe("no-future-schedule");
  });

  it("past runAt is rejected like creation", async () => {
    await expect(
      previewSpecNextRuns({ runAt: "2020-01-01T10:00:00.000+08:00" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("runAt with end rules is rejected", async () => {
    await expect(
      previewSpecNextRuns({ runAt: FUTURE, maxRuns: 3 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      previewSpecNextRuns({ runAt: FUTURE, startsAt: FUTURE }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("runAt postpone shifts past the holiday", async () => {
    const isHoliday = async (day: string) => day === "20990101";
    const out = await previewSpecNextRuns(
      { runAt: FUTURE, skipHolidays: true, holidayPolicy: "postpone" },
      { isHolidayFn: isHoliday },
    );
    expect(out.runs).toHaveLength(1);
    expect(out.runs[0]?.scheduledAt.toISOString()).toBe("2099-01-02T02:00:00.000Z");
    expect(out.runs[0]?.holidayAdjusted).toBe(true);
  });

  it("runAt drop on a holiday reports stopped", async () => {
    const isHoliday = async (day: string) => day === "20990101";
    const out = await previewSpecNextRuns(
      { runAt: FUTURE, skipHolidays: true, holidayPolicy: "drop" },
      { isHolidayFn: isHoliday },
    );
    expect(out.runs).toHaveLength(0);
    expect(out.stopped).toBe("no-future-schedule");
  });

  it("runAt at or before `from` reports stopped", async () => {
    const out = await previewSpecNextRuns({
      runAt: FUTURE,
      from: "2099-06-01T00:00:00.000+08:00",
    });
    expect(out.runs).toHaveLength(0);
    expect(out.stopped).toBe("no-future-schedule");
  });
});
