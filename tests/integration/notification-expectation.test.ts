import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/db";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import type { NotifySnapshot } from "../../src/modules/notification/service";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * 终态通知意图冻结（自愈已删，期望列当审计）：
 * 终态同一事务写 emailExpected/webhookExpected + notifySnapshot，
 * 事后改任务配置不影响旧 run 的记录。
 */

async function loadTaskDef(taskId: string) {
  const row = await prisma.task.findUnique({ where: { id: taskId } });
  if (!row) {
    throw new Error("task not found");
  }
  return {
    id: row.id,
    taskType: row.taskType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    payloadSecrets: row.payloadSecrets ? new Uint8Array(row.payloadSecrets) : null,
    timeoutMs: row.timeoutMs,
    maxAttempts: row.maxAttempts,
    tenantId: row.tenantId,
    taskName: row.name,
    recipients: (row.recipients as string[]) ?? [],
    notifyOn: (row.notifyOn as string[]) ?? [],
    webhookUrl: row.webhookUrl,
    webhookSecret: row.webhookSecret ? new Uint8Array(row.webhookSecret) : null,
  };
}

describe("terminal notification expectation snapshot", () => {
  let tenantId: string;

  beforeAll(async () => {
    registerDefaultExecutors();
    const tenant = await createTestTenant("notification-expectation");
    tenantId = tenant.id;
    await createTestToken(tenant.id, ["tasks:read", "tasks:write"], "owner");
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  it("无通知配置 → 双期望 false、有快照、无 outbox 行", async () => {
    const owner = await prisma.apiToken.findFirst({ where: { tenantId } });
    const task = await prisma.task.create({
      data: {
        name: "expect-none",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: [],
        notifyOn: ["succeeded", "failed"],
        tenantId,
        ownerTokenId: owner!.id,
      },
    });
    const outcome = await runTaskWithScheduledAt(await loadTaskDef(task.id), new Date(), "scheduled");
    const exec = await prisma.taskExecution.findUnique({ where: { id: outcome.executionId } });
    expect(exec?.emailExpected).toBe(false);
    expect(exec?.webhookExpected).toBe(false);
    expect(exec?.notifySnapshot).toBeTruthy();
    expect(await prisma.emailLog.count({ where: { runId: outcome.executionId } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { runId: outcome.executionId } })).toBe(0);
  });

  it("有 recipients → emailExpected true 且快照收件人一致", async () => {
    const owner = await prisma.apiToken.findFirst({ where: { tenantId } });
    const task = await prisma.task.create({
      data: {
        name: "expect-mail",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: ["ops@example.com"],
        notifyOn: ["succeeded", "failed"],
        tenantId,
        ownerTokenId: owner!.id,
      },
    });
    const outcome = await runTaskWithScheduledAt(await loadTaskDef(task.id), new Date(), "scheduled");
    const exec = await prisma.taskExecution.findUnique({ where: { id: outcome.executionId } });
    expect(exec?.emailExpected).toBe(true);
    expect((exec?.notifySnapshot as unknown as NotifySnapshot).recipients).toEqual([
      "ops@example.com",
    ]);
    expect(await prisma.emailLog.count({ where: { runId: outcome.executionId } })).toBe(1);
  });

  it("事后改配置不影响旧 run 的快照", async () => {
    const owner = await prisma.apiToken.findFirst({ where: { tenantId } });
    const task = await prisma.task.create({
      data: {
        name: "expect-frozen",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: [],
        notifyOn: ["succeeded", "failed"],
        tenantId,
        ownerTokenId: owner!.id,
      },
    });
    const outcome = await runTaskWithScheduledAt(await loadTaskDef(task.id), new Date(), "scheduled");
    await prisma.task.update({
      where: { id: task.id },
      data: { recipients: ["ops@example.com"], webhookUrl: "http://127.0.0.1:9/hook" },
    });
    const exec = await prisma.taskExecution.findUnique({ where: { id: outcome.executionId } });
    expect(exec?.emailExpected).toBe(false);
    expect(exec?.webhookExpected).toBe(false);
    expect((exec?.notifySnapshot as unknown as NotifySnapshot).recipients).toEqual([]);
  });
});
