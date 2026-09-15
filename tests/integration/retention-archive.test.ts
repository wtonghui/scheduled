import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/db";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import { runArchiveOnce } from "../../worker/archive";
import { claimDueItems } from "../../worker/scheduler";
import { cleanupTenant, createTestTenant, createTestToken, createTestTask } from "./helpers";

/**
 * retention 归档 + consumedRuns 配额列：
 * - 超期终态搬进归档、活表删除；pending/failed/dead/年轻行不动；dead 老行也不搬；
 * - scheduled 首 attempt 创建即 +1；合并翻 skipped 扣回；归档不碰计数；
 * - 配额判定走计数列（归档后不复活）。
 */

const DAY = 86400 * 1000;

async function seedExecution(
  taskId: string,
  tag: string,
  opts: { status: "succeeded" | "pending" | "failed"; ageDays: number; trigger?: string },
) {
  const createdAt = new Date(Date.now() - opts.ageDays * DAY);
  const exec = await prisma.taskExecution.create({
    data: {
      taskId,
      idempotencyKey: `ret-${tag}-${Date.now()}`,
      scheduledAt: createdAt,
      attempt: 1,
      trigger: opts.trigger ?? "scheduled",
      status: opts.status,
      finishedAt: opts.status === "pending" ? null : createdAt,
      createdAt,
    },
  });
  return exec;
}

async function archiveCount(table: string, col: string, val: string): Promise<number> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT COUNT(*) AS n FROM ${table} WHERE ${col} = ?`,
    val,
  )) as Array<{ n: bigint | number }>;
  return Number(rows[0]?.n ?? 0);
}

describe("retention archive", () => {
  let tenantId: string;

  beforeAll(async () => {
    registerDefaultExecutors();
    const t = await createTestTenant("retention");
    tenantId = t.id;
    await createTestToken(t.id, ["tasks:read", "tasks:write"], "owner");
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  it("moves only old terminal rows, keeps live/dead/young, stamps task_id on webhook archive", async () => {
    const task = await createTestTask(tenantId, { name: "ret-task" });
    const oldExec = await seedExecution(task.id, "old-done", { status: "succeeded", ageDays: 100 });
    await prisma.emailLog.create({
      data: {
        runId: oldExec.id,
        taskId: task.id,
        tenantId,
        toAddress: JSON.stringify(["ops@example.com"]),
        subject: "ret-old",
        html: "<p>h</p>",
        text: "t",
        status: "sent",
        maxAttempts: 5,
        createdAt: new Date(Date.now() - 100 * DAY),
      },
    });
    await prisma.webhookDelivery.create({
      data: {
        runId: oldExec.id,
        tenantId,
        webhookUrl: "http://127.0.0.1:9/hook",
        payload: { ok: true },
        status: "sent",
        maxAttempts: 5,
        createdAt: new Date(Date.now() - 100 * DAY),
      },
    });
    // 活数据：年轻 pending/failed + 老 dead（dead 永不归档，redrive 链不断）
    const youngExec = await seedExecution(task.id, "young-run", { status: "pending", ageDays: 0 });
    await prisma.emailLog.create({
      data: {
        runId: youngExec.id,
        taskId: task.id,
        tenantId,
        toAddress: JSON.stringify(["ops@example.com"]),
        subject: "ret-young",
        html: "<p>h</p>",
        text: "t",
        status: "pending",
        maxAttempts: 5,
      },
    });
    const deadExec = await seedExecution(task.id, "old-dead", { status: "failed", ageDays: 100 });
    await prisma.emailLog.create({
      data: {
        runId: deadExec.id,
        taskId: task.id,
        tenantId,
        toAddress: JSON.stringify(["ops@example.com"]),
        subject: "ret-dead",
        html: "<p>h</p>",
        text: "t",
        status: "dead",
        attempts: 5,
        maxAttempts: 5,
        createdAt: new Date(Date.now() - 100 * DAY),
      },
    });

    const summary = await runArchiveOnce();
    const moved = Object.fromEntries(summary.map((s) => [s.table, s.moved]));

    // 旧终态：活表删了，归档表有了
    expect(await prisma.emailLog.findUnique({ where: { runId: oldExec.id } })).toBeNull();
    expect(await archiveCount("email_log_archive", "run_id", oldExec.id)).toBe(1);
    expect(await prisma.webhookDelivery.findUnique({ where: { runId: oldExec.id } })).toBeNull();
    expect(await archiveCount("webhook_delivery_archive", "run_id", oldExec.id)).toBe(1);
    const archivedHook = (await prisma.$queryRawUnsafe(
      `SELECT task_id AS taskId FROM webhook_delivery_archive WHERE run_id = ?`,
      oldExec.id,
    )) as Array<{ taskId: string }>;
    expect(archivedHook[0]?.taskId).toBe(task.id);
    expect(
      await prisma.taskExecution.findUnique({ where: { id: oldExec.id } }),
    ).toBeNull();
    expect(await archiveCount("task_execution_archive", "id", oldExec.id)).toBe(1);

    // 活/死/年轻：原地不动
    expect(
      (await prisma.emailLog.findUnique({ where: { runId: youngExec.id } }))?.status,
    ).toBe("pending");
    expect((await prisma.emailLog.findUnique({ where: { runId: deadExec.id } }))?.status).toBe(
      "dead",
    );
    expect(moved.email_log).toBeGreaterThanOrEqual(1);
  });

  it("consumedRuns increments on scheduled run and drives quota after archival", async () => {
    const task = await createTestTask(tenantId, { name: "ret-quota", taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      {
        id: task.id,
        taskType: "noop",
        payload: {},
        payloadSecrets: null,
        timeoutMs: 30000,
        maxAttempts: 3,
        tenantId,
        taskName: task.name,
        recipients: [],
        notifyOn: [],
        webhookUrl: null,
        webhookSecret: null,
      },
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("succeeded");
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).consumedRuns).toBe(1);

    // 配额用尽后即使执行行被归档也不复活：清掉执行行（模拟归档），照样停用
    await prisma.task.update({ where: { id: task.id }, data: { maxRuns: 1 } });
    await prisma.taskExecution.deleteMany({ where: { taskId: task.id } });
    await prisma.task.update({
      where: { id: task.id },
      data: { nextRunAt: new Date(Date.now() - 1000) },
    });
    const items = await claimDueItems("ret-quota-worker", 60, 10);
    expect(items.some((c) => c.task.id === task.id)).toBe(false);
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).enabled).toBe(false);
  });

  it("coalesce flip decrements consumedRuns (no quota leak)", async () => {
    const task = await createTestTask(tenantId, { name: "ret-coalesce" });
    await prisma.task.update({
      where: { id: task.id },
      data: { overlapPolicy: "queue", claimedBy: "busy", claimedUntil: new Date(Date.now() + 60000) },
    });
    // 模拟 1 行待领排队（计数列同步置 1）
    const tick1 = new Date(Date.now() - 60000);
    await prisma.taskExecution.create({
      data: {
        taskId: task.id,
        idempotencyKey: `${task.id}:${tick1.toISOString()}:queued`,
        scheduledAt: tick1,
        attempt: 1,
        trigger: "queued",
        status: "pending",
      },
    });
    await prisma.task.update({
      where: { id: task.id },
      data: { consumedRuns: 1, nextRunAt: new Date(Date.now() - 20000) },
    });
    await claimDueItems("ret-coalesce-worker", 60, 10);
    // 旧排队翻 skipped 扣回、新排队 +1：净值仍为 1，且只有 1 行 pending
    expect((await prisma.task.findUniqueOrThrow({ where: { id: task.id } })).consumedRuns).toBe(1);
    const pending = await prisma.taskExecution.findMany({
      where: { taskId: task.id, trigger: "queued", status: "pending" },
    });
    expect(pending).toHaveLength(1);
    expect(
      await prisma.taskExecution.count({
        where: { taskId: task.id, trigger: "queued", status: "skipped" },
      }),
    ).toBe(1);
  });
});
