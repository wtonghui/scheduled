import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/db";
import { runEmailRelayOnce } from "../../worker/relay";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * 任务 2（B 方案）：认领写显式 deadline，回收只看它。
 * - 过期 deadline → 回收投出；未来 deadline → 不动；遗留 NULL 行 → updatedAt 回退回收；
 * - 正常领取的行 sent 后保留 deadline ≈ now+10min（证明认领写了它）。
 */

async function seedInProgress(
  tenantId: string,
  taskId: string,
  tag: string,
  data: { nextRetryAt: Date | null; backdateMinutes?: number },
): Promise<string> {
  const exec = await prisma.taskExecution.create({
    data: {
      taskId,
      idempotencyKey: `deadline-${tag}-${Date.now()}`,
      scheduledAt: new Date(),
      attempt: 1,
      trigger: "scheduled",
      status: "succeeded",
      finishedAt: new Date(),
    },
  });
  await prisma.emailLog.create({
    data: {
      runId: exec.id,
      taskId,
      tenantId,
      toAddress: JSON.stringify(["ops@example.com"]),
      subject: `deadline-${tag}`,
      html: "<p>h</p>",
      text: "t",
      status: "in_progress",
      maxAttempts: 5,
      nextRetryAt: data.nextRetryAt,
    },
  });
  if (data.backdateMinutes) {
    await prisma.$executeRaw`UPDATE email_log SET updated_at = DATE_SUB(NOW(), INTERVAL 60 MINUTE) WHERE run_id = ${exec.id}`;
  }
  return exec.id;
}

describe("relay claim deadline", () => {
  let tenantId: string;

  beforeAll(async () => {
    const t = await createTestTenant("relay-deadline");
    tenantId = t.id;
    await createTestToken(t.id, ["tasks:read", "tasks:write"], "owner");
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  it("reclaims by deadline, spares the future, keeps legacy fallback, stamps new claims", async () => {
    const token = await prisma.apiToken.findFirstOrThrow({ where: { tenantId } });
    const task = await prisma.task.create({
      data: {
        name: "deadline-task",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
        tenantId,
        ownerTokenId: token.id,
      },
    });
    const past = new Date(Date.now() - 60_000);
    const future = new Date(Date.now() + 30 * 60_000);
    const expiredRun = await seedInProgress(tenantId, task.id, "expired", { nextRetryAt: past });
    const futureRun = await seedInProgress(tenantId, task.id, "future", { nextRetryAt: future });
    const legacyRun = await seedInProgress(tenantId, task.id, "legacy", {
      nextRetryAt: null,
      backdateMinutes: 60,
    });
    // 正常 pending 行：走认领→发送，sent 后 deadline 应≈now+10min（认领写了它）
    const exec = await prisma.taskExecution.create({
      data: {
        taskId: task.id,
        idempotencyKey: `deadline-fresh-${Date.now()}`,
        scheduledAt: new Date(),
        attempt: 1,
        trigger: "scheduled",
        status: "succeeded",
        finishedAt: new Date(),
      },
    });
    await prisma.emailLog.create({
      data: {
        runId: exec.id,
        taskId: task.id,
        tenantId,
        toAddress: JSON.stringify(["ops@example.com"]),
        subject: "deadline-fresh",
        html: "<p>h</p>",
        text: "t",
        status: "pending",
        maxAttempts: 5,
      },
    });

    await runEmailRelayOnce(20);

    expect((await prisma.emailLog.findUniqueOrThrow({ where: { runId: expiredRun } })).status).toBe(
      "sent",
    );
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { runId: legacyRun } })).status).toBe(
      "sent",
    );
    expect((await prisma.emailLog.findUniqueOrThrow({ where: { runId: futureRun } })).status).toBe(
      "in_progress",
    );
    const fresh = await prisma.emailLog.findUniqueOrThrow({ where: { runId: exec.id } });
    expect(fresh.status).toBe("sent");
    const skew = (fresh.nextRetryAt?.getTime() ?? 0) - Date.now();
    expect(skew).toBeGreaterThan(9 * 60_000);
    expect(skew).toBeLessThanOrEqual(10 * 60_000);
  });
});
