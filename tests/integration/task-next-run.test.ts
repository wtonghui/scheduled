import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { config } from "../../src/lib/config";
import * as taskService from "../../src/modules/task/service";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * 下次运行预览（service 层）：详情 enrichment、一次性回显、租户隔离、spec 校验。
 * 假日分支由单测覆盖（注入 isHolidayFn），这里不断言节假日、只走无假日路径。
 */

describe("task next-run preview (integration)", () => {
  let tenantId: string;
  let ownerTokenId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    const t = await createTestTenant("next-run");
    tenantId = t.id;
    ownerTokenId = (await createTestToken(tenantId, ["tasks:read", "tasks:write"], "owner")).id;
    otherTenantId = (await createTestTenant("next-run-other")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
    await cleanupTenant(otherTenantId);
  });

  it("detail enriches upcoming for a repeating task", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "upcoming-cron",
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    const view = await taskService.getAny(created.id, tenantId);
    expect(view.upcoming).not.toBeNull();
    expect(view.upcoming?.scheduledAt).toBeInstanceOf(Date);
    expect(view.upcoming?.stoppedReason).toBeNull();
  });

  it("run-once task mirrors the stored nextRunAt", async () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "upcoming-once",
      runAt,
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    const view = await taskService.getAny(created.id, tenantId);
    expect(view.upcoming?.scheduledAt?.getTime()).toBe(new Date(runAt).getTime());
    expect(view.upcoming?.holidayAdjusted).toBe(false);
  });

  it("tenant-scoped read of another tenant 404s", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "upcoming-iso",
      cron: "0 9 * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await expect(taskService.get(otherTenantId, created.id)).rejects.toMatchObject({
      status: 404,
    });
  });

  it("spec preview validates the triple", async () => {
    await expect(taskService.previewSpecNextRuns({})).rejects.toMatchObject({ status: 400 });
    await expect(
      taskService.previewSpecNextRuns({ cron: "0 9 * * *", scheduleIntervalSeconds: 60 }),
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      taskService.previewSpecNextRuns({ cron: "not a cron" }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("spec preview supports a future runAt (single shot, terminal stopped)", async () => {
    const out = await taskService.previewSpecNextRuns({
      runAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(out.runs).toHaveLength(1);
    expect(out.stopped).toBe("no-future-schedule");
  });

  it("spec preview returns ascending runs", async () => {
    const out = await taskService.previewSpecNextRuns({
      cron: "0 9 * * *",
      timezone: "Asia/Shanghai",
      count: 3,
    });
    expect(out.stopped).toBeNull();
    expect(out.runs).toHaveLength(3);
    const times = out.runs.map((r) => r.scheduledAt.getTime());
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });
});

describe("runAt with holidays (integration, stubbed calendar API)", () => {
  let tenantId: string;
  let ownerTokenId: string;
  const savedUrl = config.HOLIDAY_API_URL;
  const savedKey = config.HOLIDAY_API_APP_KEY;

  beforeAll(async () => {
    const t = await createTestTenant("next-run-hol");
    tenantId = t.id;
    ownerTokenId = (await createTestToken(tenantId, ["tasks:read", "tasks:write"], "owner")).id;
  });

  beforeEach(() => {
    config.HOLIDAY_API_URL = "http://holiday.test/api";
    config.HOLIDAY_API_APP_KEY = "k";
    // 2099-01-01 全天假日，其余工作日
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}")) as {
          params?: { natural_day?: string };
        };
        const day = body.params?.natural_day ?? "";
        return new Response(
          JSON.stringify({
            code: "0",
            msg: "OK",
            data: { total: 1, rows: [{ natural_day: day, is_workday: day === "20990101" ? "N" : "Y" }] },
            status: 200,
            success: true,
          }),
          { status: 200 },
        );
      }),
    );
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
    config.HOLIDAY_API_URL = savedUrl;
    config.HOLIDAY_API_APP_KEY = savedKey;
    vi.unstubAllGlobals();
  });

  it("creates runAt+postpone stored at the shifted workday", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "once-postpone",
      runAt: "2099-01-01T10:00:00.000+08:00",
      skipHolidays: true,
      holidayPolicy: "postpone",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    // 顺延到次日同一墙钟
    expect(created.nextRunAt?.toISOString()).toBe("2099-01-02T02:00:00.000Z");
    expect(created.upcoming?.scheduledAt?.toISOString()).toBe("2099-01-02T02:00:00.000Z");
  });

  it("creates runAt+drop on a holiday is rejected", async () => {
    await expect(
      taskService.create(tenantId, ownerTokenId, {
        name: "once-drop",
        runAt: "2099-01-01T10:00:00.000+08:00",
        skipHolidays: true,
        holidayPolicy: "drop",
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ status: 400 });
  });
});
