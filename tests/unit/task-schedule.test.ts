import { describe, expect, it } from "vitest";
import { isValidTimezone } from "../../src/lib/cron";
import {
  CreateTaskSchema,
  UpdateTaskSchema,
  isValidScheduleTriple,
} from "../../src/modules/task/dto";

describe("isValidTimezone", () => {
  it("accepts IANA names", () => {
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
    expect(isValidTimezone("America/New_York")).toBe(true);
  });

  it("rejects garbage", () => {
    expect(isValidTimezone("Mars/Olympus")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
    expect(isValidTimezone("  ")).toBe(false);
  });
});

describe("isValidScheduleTriple", () => {
  it("requires exactly one of cron/interval/runAt", () => {
    expect(isValidScheduleTriple({ cron: "* * * * *" })).toBe(true);
    expect(isValidScheduleTriple({ scheduleIntervalSeconds: 60 })).toBe(true);
    expect(isValidScheduleTriple({ runAt: "2099-01-01T09:00:00+08:00" })).toBe(true);
    expect(isValidScheduleTriple({})).toBe(false);
    expect(isValidScheduleTriple({ cron: "* * * * *", runAt: "2099-01-01T09:00:00+08:00" })).toBe(
      false,
    );
    expect(
      isValidScheduleTriple({ scheduleIntervalSeconds: 60, runAt: "2099-01-01T09:00:00+08:00" }),
    ).toBe(false);
  });
});

const baseCreate = {
  name: "t",
  taskType: "noop" as const,
  payload: {},
  recipients: ["ops@example.com"],
};

describe("CreateTaskSchema schedule fields", () => {
  it("accepts runAt-only (run-once)", () => {
    const r = CreateTaskSchema.safeParse({ ...baseCreate, runAt: "2099-01-01T09:00:00+08:00" });
    expect(r.success).toBe(true);
  });

  it("rejects past runAt", () => {
    const r = CreateTaskSchema.safeParse({ ...baseCreate, runAt: "2000-01-01T09:00:00+08:00" });
    expect(r.success).toBe(false);
  });

  it("rejects cron+runAt together", () => {
    const r = CreateTaskSchema.safeParse({
      ...baseCreate,
      cron: "0 9 * * *",
      runAt: "2099-01-01T09:00:00+08:00",
    });
    expect(r.success).toBe(false);
  });

  it("rejects timezone with interval", () => {
    const r = CreateTaskSchema.safeParse({
      ...baseCreate,
      scheduleIntervalSeconds: 60,
      timezone: "UTC",
    });
    expect(r.success).toBe(false);
  });

  it("accepts timezone with runAt (wall-clock context for one-time moment)", () => {
    const r = CreateTaskSchema.safeParse({
      ...baseCreate,
      runAt: "2099-01-01T09:00:00+08:00",
      timezone: "Asia/Shanghai",
    });
    expect(r.success).toBe(true);
  });

  it("accepts timezone with cron, rejects unknown zone", () => {
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, cron: "0 9 * * *", timezone: "UTC" }).success,
    ).toBe(true);
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, cron: "0 9 * * *", timezone: "Nope/Zone" })
        .success,
    ).toBe(false);
  });

  it("validates retryDelayMs range", () => {
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, cron: "* * * * *", retryDelayMs: 300000 })
        .success,
    ).toBe(true);
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, cron: "* * * * *", retryDelayMs: -1 }).success,
    ).toBe(false);
  });

  it("defaults overlapPolicy to skip, rejects unknown policy", () => {
    const ok = CreateTaskSchema.safeParse({ ...baseCreate, cron: "* * * * *" });
    expect(ok.success && ok.data.overlapPolicy).toBe("skip");
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, cron: "* * * * *", overlapPolicy: "whenever" })
        .success,
    ).toBe(false);
  });

  it("rejects past endsAt and non-positive maxRuns", () => {
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        cron: "* * * * *",
        endsAt: "2000-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, cron: "* * * * *", maxRuns: 0 }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        cron: "* * * * *",
        endsAt: "2099-01-01T00:00:00Z",
        maxRuns: 10,
      }).success,
    ).toBe(true);
  });

  it("rejects end rules / overlap with runAt", () => {
    const runAt = "2099-01-01T09:00:00+08:00";
    expect(CreateTaskSchema.safeParse({ ...baseCreate, runAt, maxRuns: 1 }).success).toBe(false);
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, runAt, endsAt: "2099-06-01T00:00:00Z" }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({ ...baseCreate, runAt, overlapPolicy: "queue" }).success,
    ).toBe(false);
  });
});

describe("UpdateTaskSchema schedule fields", () => {
  it("accepts runAt-only switch", () => {
    expect(
      UpdateTaskSchema.safeParse({ runAt: "2099-01-01T09:00:00+08:00", version: 1 }).success,
    ).toBe(true);
  });

  it("rejects cron+runAt together", () => {
    expect(
      UpdateTaskSchema.safeParse({
        cron: "0 9 * * *",
        runAt: "2099-01-01T09:00:00+08:00",
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("allows lone timezone (service validates against effective schedule)", () => {
    expect(UpdateTaskSchema.safeParse({ timezone: "UTC", version: 1 }).success).toBe(true);
  });

  it("rejects runAt + end rules in the same patch", () => {
    expect(
      UpdateTaskSchema.safeParse({
        runAt: "2099-01-01T09:00:00+08:00",
        maxRuns: 5,
        version: 1,
      }).success,
    ).toBe(false);
  });

  it("accepts end-rule-only patches", () => {
    expect(
      UpdateTaskSchema.safeParse({
        endsAt: "2099-06-01T00:00:00Z",
        maxRuns: 100,
        overlapPolicy: "queue",
        version: 1,
      }).success,
    ).toBe(true);
  });

  it("accepts startsAt-only (future), rejects past and runAt combo", () => {
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        cron: "* * * * *",
        startsAt: "2099-01-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        cron: "* * * * *",
        startsAt: "2000-01-01T00:00:00Z",
      }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        runAt: "2099-01-01T09:00:00+08:00",
        startsAt: "2099-06-01T00:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("rejects holiday rules with runAt, policy-without-skip", () => {
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        runAt: "2099-01-01T09:00:00+08:00",
        skipHolidays: true,
      }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        cron: "* * * * *",
        holidayPolicy: "postpone",
      }).success,
    ).toBe(false);
    expect(
      CreateTaskSchema.safeParse({
        ...baseCreate,
        cron: "* * * * *",
        skipHolidays: true,
        holidayPolicy: "postpone",
      }).success,
    ).toBe(true);
  });

  it("rejects runAt + startsAt in the same patch", () => {
    expect(
      UpdateTaskSchema.safeParse({
        runAt: "2099-01-01T09:00:00+08:00",
        startsAt: "2099-06-01T00:00:00Z",
        version: 1,
      }).success,
    ).toBe(false);
  });
});
