import { prisma } from "../../src/lib/db";
import { createApiToken } from "../../src/modules/auth/service";

/**
 * 集成测试助手：创建独立租户 + token，结束后级联清理。
 * 每个测试文件使用唯一租户名，避免与 seed 的默认租户冲突。
 */

const COUNTER = { n: 0 };

export async function createTestTenant(name = "test-tenant") {
  COUNTER.n += 1;
  const tenant = await prisma.tenant.create({
    data: { name: `${name}-${Date.now()}-${COUNTER.n}` },
  });
  return tenant;
}

export async function createTestToken(tenantId: string, scopes: string[], name = "test") {
  return createApiToken({ tenantId, scopes, name });
}

export async function createTestTask(
  tenantId: string,
  overrides: Partial<{
    name: string;
    cron: string | null;
    scheduleIntervalSeconds: number | null;
    taskType: "http" | "noop";
    payload: Record<string, unknown>;
    enabled: boolean;
    maxAttempts: number;
    timeoutMs: number;
    recipients: string[];
    nextRunAt: Date | null;
    ownerTokenId?: string;
  }> = {},
) {
  // task.owner_token_id 必填（FK→api_token）；默认兜底为该租户最早签发的 token
  const ownerTokenId =
    overrides.ownerTokenId ??
    (
      await prisma.apiToken.findFirst({
        where: { tenantId },
        orderBy: { createdAt: "asc" },
      })
    )?.id;
  if (!ownerTokenId) {
    throw new Error(
      `createTestTask: tenant ${tenantId} has no api token — create one via createTestToken first`,
    );
  }
  return prisma.task.create({
    data: {
      name: overrides.name ?? `task-${Date.now()}`,
      cron: "cron" in overrides ? (overrides.cron ?? null) : "*/5 * * * *",
      scheduleIntervalSeconds: overrides.scheduleIntervalSeconds ?? null,
      taskType: overrides.taskType ?? "noop",
      payload: overrides.payload ?? {},
      enabled: overrides.enabled ?? true,
      maxAttempts: overrides.maxAttempts ?? 3,
      timeoutMs: overrides.timeoutMs ?? 30_000,
      recipients: overrides.recipients ?? ["ops@example.com"],
      nextRunAt: overrides.nextRunAt ?? new Date(Date.now() + 60_000),
      tenantId,
      ownerTokenId,
    },
  });
}

export async function cleanupTenant(tenantId: string) {
  // 注意删除顺序：email_log/webhook_delivery 经 run_id FK 引用 task_execution
  await prisma.emailLog.deleteMany({ where: { tenantId } });
  await prisma.webhookDelivery.deleteMany({ where: { tenantId } });
  await prisma.taskExecution.deleteMany({
    where: { task: { tenantId } },
  });
  await prisma.task.deleteMany({ where: { tenantId } });
  await prisma.apiToken.deleteMany({ where: { tenantId } });
  await prisma.tenant.delete({ where: { id: tenantId } }).catch(() => {});
}

export async function closeDb() {
  await prisma.$disconnect();
}
