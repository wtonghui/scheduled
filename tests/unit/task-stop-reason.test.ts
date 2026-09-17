import { describe, expect, it } from "vitest";
import { resolveAutoStopReason } from "../../worker/scheduler";

/** 自动停用原因判定：纯函数，零 DB，与 claim/对账同口径（maxRuns → endsAt → 下次超窗 → 单次 → 无未来计划）。 */

const tick = new Date("2026-09-17T10:00:00.000Z");

describe("resolveAutoStopReason", () => {
  it("returns null when the task continues (advanceTo non-null)", () => {
    expect(
      resolveAutoStopReason(
        { runAt: null, endsAt: null, maxRuns: null, consumedRuns: 0 },
        tick,
        new Date("2026-09-17T11:00:00.000Z"),
        new Date("2026-09-17T11:00:00.000Z"),
      ),
    ).toBeNull();
  });

  it("max_runs wins when quota is exhausted (even with endsAt also hit)", () => {
    expect(
      resolveAutoStopReason(
        {
          runAt: null,
          endsAt: new Date("2026-09-17T09:00:00.000Z"),
          maxRuns: 3,
          consumedRuns: 3,
        },
        tick,
        null,
        null,
      ),
    ).toBe("max_runs");
  });

  it("ends_at when the tick is past the deadline", () => {
    expect(
      resolveAutoStopReason(
        {
          runAt: null,
          endsAt: new Date("2026-09-17T09:00:00.000Z"),
          maxRuns: null,
          consumedRuns: 0,
        },
        tick,
        null,
        null,
      ),
    ).toBe("ends_at");
  });

  it("ends_at when the tick is inside but the next run exceeds the deadline", () => {
    expect(
      resolveAutoStopReason(
        {
          runAt: null,
          endsAt: new Date("2026-09-17T10:30:00.000Z"),
          maxRuns: null,
          consumedRuns: 0,
        },
        tick,
        new Date("2026-09-17T11:00:00.000Z"),
        null,
      ),
    ).toBe("ends_at");
  });

  it("run_once_done for single-shot tasks", () => {
    expect(
      resolveAutoStopReason(
        { runAt: new Date("2026-09-17T10:00:00.000Z"), endsAt: null, maxRuns: null, consumedRuns: 0 },
        tick,
        null,
        null,
      ),
    ).toBe("run_once_done");
  });

  it("no_future_schedule when the schedule itself yields nothing", () => {
    expect(
      resolveAutoStopReason(
        { runAt: null, endsAt: null, maxRuns: null, consumedRuns: 0 },
        tick,
        null,
        null,
      ),
    ).toBe("no_future_schedule");
  });
});
