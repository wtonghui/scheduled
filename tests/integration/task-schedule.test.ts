import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/db";
import * as taskService from "../../src/modules/task/service";
import { claimDueItems } from "../../worker/scheduler";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * 调度扩展集成测试（T1/T2/T3）：
 * runAt 一次性、timezone 透传、retryDelayMs 落库，以及一次性任务"领一次即停用"闭环。
 */

function nyHourOf(date: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  return Number(parts.find((p) => p.type === "hour")?.value);
}

describe("task schedule extensions (integration)", () => {
  let tenantId: string;
  let ownerTokenId: string;

  beforeAll(async () => {
    const t = await createTestTenant("sched-ext");
    tenantId = t.id;
    ownerTokenId = (await createTestToken(tenantId, ["tasks:read", "tasks:write"], "owner")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  it("creates a run-once task with nextRunAt == runAt", async () => {
    const runAt = new Date(Date.now() + 3_600_000).toISOString();
    const view = await taskService.create(tenantId, ownerTokenId, {
      name: "once",
      runAt,
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    expect(view.runAt).toBeInstanceOf(Date);
    expect((view.runAt as Date).getTime()).toBe(new Date(runAt).getTime());
    expect(view.nextRunAt?.getTime()).toBe(new Date(runAt).getTime());
    expect(view.cron).toBeNull();
    expect(view.timezone).toBe("Asia/Shanghai");
    expect(view.retryDelayMs).toBeNull();
  });

  it("rejects past runAt → 400", async () => {
    await expect(
      taskService.create(tenantId, ownerTokenId, {
        name: "once-past",
        runAt: new Date(Date.now() - 1_000).toISOString(),
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("rejects cron+runAt together → 400", async () => {
    await expect(
      taskService.create(tenantId, ownerTokenId, {
        name: "both",
        cron: "0 9 * * *",
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("stores timezone and computes nextRunAt in that zone", async () => {
    const view = await taskService.create(tenantId, ownerTokenId, {
      name: "ny-daily",
      cron: "0 9 * * *",
      timezone: "America/New_York",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    expect(view.timezone).toBe("America/New_York");
    expect(view.nextRunAt).toBeInstanceOf(Date);
    // 纽约墙钟 9 点（夏令/冬令都成立，只看小时）
    expect(nyHourOf(view.nextRunAt as Date)).toBe(9);
  });

  it("rejects timezone with interval → 400", async () => {
    await expect(
      taskService.create(tenantId, ownerTokenId, {
        name: "interval-tz",
        scheduleIntervalSeconds: 60,
        timezone: "UTC",
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("stores retryDelayMs and round-trips on update", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "retry-custom",
      cron: "* * * * *",
      retryDelayMs: 300_000,
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    expect(created.retryDelayMs).toBe(300_000);
    const updated = await taskService.update(tenantId, created.id, {
      retryDelayMs: 60_000,
      version: created.version,
    });
    expect(updated.retryDelayMs).toBe(60_000);
  });

  it("update cron→runAt clears cron (keeps triple invariant)", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "switch",
      cron: "0 9 * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    const runAt = new Date(Date.now() + 7_200_000).toISOString();
    const updated = await taskService.update(tenantId, created.id, {
      runAt,
      version: created.version,
    });
    expect(updated.runAt?.toISOString()).toBe(new Date(runAt).toISOString());
    expect(updated.cron).toBeNull();
    expect(updated.scheduleIntervalSeconds).toBeNull();
  });

  it("update timezone on interval task → 400", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "interval-task",
      scheduleIntervalSeconds: 300,
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await expect(
      taskService.update(tenantId, created.id, { timezone: "UTC", version: created.version }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("run-once task: claimed once then auto-disabled (no future run)", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "once-claim",
      runAt: new Date(Date.now() + 1_200).toISOString(),
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    const items = await claimDueItems("sched-ext-worker", 30, 10);
    expect(items.some((i) => i.task.id === created.id)).toBe(true);
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(false);
    expect(row?.nextRunAt).toBeNull();
  }, 15_000);
});

describe("end rules + overlap policy (integration)", () => {
  let tenantId: string;
  let ownerTokenId: string;

  beforeAll(async () => {
    const t = await createTestTenant("sched-policy");
    tenantId = t.id;
    ownerTokenId = (await createTestToken(tenantId, ["tasks:read", "tasks:write"], "owner")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  /** 到期但被租约挡住的任务（模拟上次仍在跑）。 */
  async function holdLease(taskId: string, policy: string) {
    await prisma.task.update({
      where: { id: taskId },
      data: {
        overlapPolicy: policy,
        claimedBy: "busy-worker",
        claimedUntil: new Date(Date.now() + 60_000),
        nextRunAt: new Date(Date.now() - 1_000),
      },
    });
  }

  it("rejects endsAt before the first run → 400", async () => {
    await expect(
      taskService.create(tenantId, ownerTokenId, {
        name: "ends-too-early",
        cron: "0 9 1 1 *",
        endsAt: new Date(Date.now() + 3_600_000).toISOString(),
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("rejects end rules on run-once tasks → 400", async () => {
    await expect(
      taskService.create(tenantId, ownerTokenId, {
        name: "once-with-max",
        runAt: new Date(Date.now() + 3_600_000).toISOString(),
        maxRuns: 1,
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("maxRuns exhausted → disabled without running", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "quota",
      cron: "* * * * *",
      maxRuns: 1,
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    // 模拟已跑满 1 次（attempt=1 的调度触发行才计数）
    await prisma.taskExecution.create({
      data: {
        taskId: created.id,
        idempotencyKey: `${created.id}:seed:a1`,
        scheduledAt: new Date(Date.now() - 60_000),
        attempt: 1,
        trigger: "scheduled",
        status: "succeeded",
      },
    });
    await prisma.task.update({
      where: { id: created.id },
      data: { nextRunAt: new Date(Date.now() - 1_000) },
    });
    const items = await claimDueItems("sched-policy-worker", 30, 10);
    expect(items.some((i) => i.task.id === created.id)).toBe(false);
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(false);
    expect(row?.nextRunAt).toBeNull();
  });

  it("endsAt passed → disabled without running", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "expired",
      cron: "* * * * *",
      endsAt: new Date(Date.now() + 3_600_000).toISOString(),
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    // 绕过 DTO（已过截止）：直接改行模拟过期
    await prisma.task.update({
      where: { id: created.id },
      data: { endsAt: new Date(Date.now() - 1_000), nextRunAt: new Date(Date.now() - 1_000) },
    });
    const items = await claimDueItems("sched-policy-worker", 30, 10);
    expect(items.some((i) => i.task.id === created.id)).toBe(false);
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(false);
  });

  it("skip policy writes a skipped audit row and advances", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "skip-me",
      cron: "* * * * *",
      overlapPolicy: "skip",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await holdLease(created.id, "skip");
    await claimDueItems("sched-policy-worker", 30, 10);
    const skipped = await prisma.taskExecution.findFirst({
      where: { taskId: created.id, status: "skipped" },
    });
    expect(skipped).not.toBeNull();
    const row = await prisma.task.findUnique({ where: { id: created.id } });
    expect(row?.enabled).toBe(true);
    expect((row?.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now() - 1_000);
  });

  it("queue policy enqueues a pending row instead of running", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "queue-me",
      cron: "* * * * *",
      overlapPolicy: "queue",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await holdLease(created.id, "queue");
    const items = await claimDueItems("sched-policy-worker", 30, 10);
    expect(items.some((i) => i.task.id === created.id)).toBe(false);
    const queued = await prisma.taskExecution.findFirst({
      where: { taskId: created.id, trigger: "queued", status: "pending" },
    });
    expect(queued).not.toBeNull();
  });

  it("run policy force-claims despite the lease", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "run-me",
      cron: "* * * * *",
      overlapPolicy: "run",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    await holdLease(created.id, "run");
    const items = await claimDueItems("sched-policy-worker", 30, 10);
    expect(items.some((i) => i.task.id === created.id)).toBe(true);
  });
});
