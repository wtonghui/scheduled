import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { prisma } from "../../src/lib/db";
import { runEmailRelayOnce } from "../../worker/relay";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * P1-3 公平取批：大租户积压时，小租户首轮即被投出（FIFO 下要等整批）。
 * 断言只看本租户行终态，不依赖全局计数（中继无租户过滤，跨文件串扰只影响计数）。
 */

async function seedPendingEmails(
  tenantId: string,
  taskId: string,
  n: number,
  tag: string,
): Promise<string[]> {
  const runIds: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const exec = await prisma.taskExecution.create({
      data: {
        taskId,
        idempotencyKey: `fair-${tag}-${Date.now()}-${i}`,
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
        subject: `fair-${tag}-${i}`,
        html: "<p>h</p>",
        text: "t",
        status: "pending",
        maxAttempts: 5,
      },
    });
    runIds.push(exec.id);
  }
  return runIds;
}

describe("relay fairness", () => {
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    const a = await createTestTenant("fair-a");
    const b = await createTestTenant("fair-b");
    tenantA = a.id;
    tenantB = b.id;
    await createTestToken(a.id, ["tasks:read", "tasks:write"], "owner");
    await createTestToken(b.id, ["tasks:read", "tasks:write"], "owner");
  });

  afterAll(async () => {
    await cleanupTenant(tenantA);
    await cleanupTenant(tenantB);
  });

  it("small tenant is served in the first round despite big tenant backlog", async () => {
    const tokenA = await prisma.apiToken.findFirstOrThrow({ where: { tenantId: tenantA } });
    const tokenB = await prisma.apiToken.findFirstOrThrow({ where: { tenantId: tenantB } });
    const taskA = await prisma.task.create({
      data: {
        name: "fair-backlog",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
        tenantId: tenantA,
        ownerTokenId: tokenA.id,
      },
    });
    const taskB = await prisma.task.create({
      data: {
        name: "fair-single",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
        tenantId: tenantB,
        ownerTokenId: tokenB.id,
      },
    });
    await seedPendingEmails(tenantA, taskA.id, 20, "a");
    const [bRun] = await seedPendingEmails(tenantB, taskB.id, 1, "b");

    await runEmailRelayOnce(20);

    // B 只有 1 条：公平份额≥1，首轮必发出（纯 FIFO 下前 20 全是 A 的）
    const bRow = await prisma.emailLog.findUniqueOrThrow({ where: { runId: bRun! } });
    expect(bRow.status).toBe("sent");
  });
});
