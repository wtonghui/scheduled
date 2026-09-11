import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  __clearHolidayCacheForTest,
  adjustForHolidays,
  isHoliday,
  parseHolidayResponse,
  toNaturalDay,
} from "../../src/lib/holiday";

afterEach(() => {
  __clearHolidayCacheForTest();
  vi.unstubAllGlobals();
});

/** 按真实返回拼响应：code 字符串 "0"，rows[0].is_workday Y/N。 */
function realResponse(flag: unknown, extra: Record<string, unknown> = {}) {
  return {
    code: "0",
    msg: "OK",
    data: {
      total: 1,
      rows: [{ natural_day: "20260909", is_workday: flag, ...extra }],
    },
    status: 200,
    success: true,
    ...extra,
  };
}

describe("parseHolidayResponse (真实形状)", () => {
  it("is_workday Y → 工作日(false)，N → 假日(true)", () => {
    expect(parseHolidayResponse(realResponse("Y"))).toBe(false);
    expect(parseHolidayResponse(realResponse("N"))).toBe(true);
  });

  it("returns null for non-zero code / success false / missing shape", () => {
    expect(parseHolidayResponse({ ...realResponse("Y"), code: "1" })).toBeNull();
    expect(parseHolidayResponse({ ...realResponse("Y"), success: false })).toBeNull();
    expect(
      parseHolidayResponse({ code: "0", msg: "OK", data: { total: 0, rows: [] }, success: true }),
    ).toBeNull();
    expect(parseHolidayResponse({ code: "0", msg: "OK", success: true })).toBeNull();
    expect(parseHolidayResponse({ code: "0", msg: "OK", data: null, success: true })).toBeNull();
    expect(parseHolidayResponse(null)).toBeNull();
    expect(parseHolidayResponse("holiday")).toBeNull();
    expect(parseHolidayResponse(realResponse("X"))).toBeNull();
    expect(parseHolidayResponse(realResponse(1))).toBeNull();
  });

  it("accepts numeric code 0 (defensive)", () => {
    expect(parseHolidayResponse({ ...realResponse("N"), code: 0 })).toBe(true);
  });
});

describe("toNaturalDay", () => {
  it("uses wall-clock date in the given timezone", () => {
    // 2026-01-01T01:00Z = 上海 09:00（1日）/ 纽约前一日 20:00（12月31日）
    const d = new Date("2026-01-01T01:00:00.000Z");
    expect(toNaturalDay(d, "Asia/Shanghai")).toBe("20260101");
    expect(toNaturalDay(d, "America/New_York")).toBe("20251231");
  });
});

function mockFetch(holidays: Set<string>, calls: string[]) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { body?: string }) => {
      const body = JSON.parse((init?.body as string) ?? "{}") as {
        params?: { natural_day?: string };
      };
      const day = body.params?.natural_day ?? "";
      calls.push(day);
      const isHoliday = holidays.has(day);
      return {
        ok: true,
        json: async () => ({
          code: "0",
          msg: "OK",
          data: { total: 1, rows: [{ natural_day: day, is_workday: isHoliday ? "N" : "Y" }] },
          status: 200,
          success: true,
        }),
      };
    }),
  );
}

const OPTS = { url: "http://holiday.test/api", appKey: "k", timeoutMs: 5000 };

describe("isHoliday (cache + fail-open)", () => {
  it("returns null when api unconfigured", async () => {
    expect(await isHoliday("20260101")).toBeNull();
  });

  it("caches same day (fetch once for two calls)", async () => {
    const calls: string[] = [];
    mockFetch(new Set(["20260101"]), calls);
    expect(await isHoliday("20260101", OPTS)).toBe(true);
    expect(await isHoliday("20260101", OPTS)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("non-200 / throw → null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 500 })),
    );
    expect(await isHoliday("20260101", OPTS)).toBeNull();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("down");
      }),
    );
    __clearHolidayCacheForTest();
    expect(await isHoliday("20260102", OPTS)).toBeNull();
  });
});

describe("adjustForHolidays", () => {
  // Mon 2026-09-07 / Tue 2026-09-08（+08 墙钟 09:00）
  const MON = DateTime.fromISO("2026-09-07T09:00:00", { zone: "Asia/Shanghai" }).toJSDate();
  const TUE = DateTime.fromISO("2026-09-08T09:00:00", { zone: "Asia/Shanghai" }).toJSDate();
  const WED = DateTime.fromISO("2026-09-09T09:00:00", { zone: "Asia/Shanghai" }).toJSDate();
  const plusDay = (d: Date) => DateTime.fromJSDate(d).plus({ days: 1 }).toJSDate();
  const fake = (holidays: Set<string>) => async (day: string) => holidays.has(day);

  it("drop: skips consecutive holidays to next workday tick", async () => {
    const out = await adjustForHolidays({
      candidate: MON,
      policy: "drop",
      timezone: "Asia/Shanghai",
      nextAfter: plusDay,
      isHolidayFn: fake(new Set(["20260907", "20260908"])),
    });
    expect(out?.toISOString()).toBe(WED.toISOString());
  });

  it("postpone: moves to next workday same wall time", async () => {
    const out = await adjustForHolidays({
      candidate: MON,
      policy: "postpone",
      timezone: "Asia/Shanghai",
      nextAfter: plusDay,
      isHolidayFn: fake(new Set(["20260907"])),
    });
    expect(out?.toISOString()).toBe(TUE.toISOString());
    expect(
      DateTime.fromJSDate(out as Date)
        .setZone("Asia/Shanghai")
        .toFormat("HH:mm"),
    ).toBe("09:00");
  });

  it("unknown (null) treated as workday", async () => {
    const out = await adjustForHolidays({
      candidate: MON,
      policy: "drop",
      timezone: "Asia/Shanghai",
      nextAfter: plusDay,
      isHolidayFn: async () => null,
    });
    expect(out?.toISOString()).toBe(MON.toISOString());
  });

  it("null candidate → null", async () => {
    const out = await adjustForHolidays({
      candidate: null,
      policy: "drop",
      timezone: "Asia/Shanghai",
      nextAfter: plusDay,
      isHolidayFn: fake(new Set()),
    });
    expect(out).toBeNull();
  });

  it("all-holiday fail-open after bound", async () => {
    const out = await adjustForHolidays({
      candidate: MON,
      policy: "drop",
      timezone: "Asia/Shanghai",
      nextAfter: plusDay,
      isHolidayFn: async () => true,
    });
    expect(out?.toISOString()).toBe(MON.toISOString());
  });
});
