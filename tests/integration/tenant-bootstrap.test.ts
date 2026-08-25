import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ensureBootstrap } from "../../src/modules/tenant/service";
import { prisma } from "../../src/lib/db";
import { createTestTenant, createTestToken, cleanupTenant } from "./helpers";

/**
 * 租户引导（FR-015）：ensureBootstrap 幂等 + createTestTenant/cleanupTenant 隔离助手。
 */
describe("tenant bootstrap", () => {
  beforeAll(async () => {
    // 与 seed 隔离：不创建新租户，仅验证幂等性（seed 已建默认租户 + bootstrap token）
    await ensureBootstrap();
  });

  afterAll(async () => {
    // 若本测试并行引入了多余 bootstrap token，清理至 1 个
    const rows = await prisma.apiToken.findMany({
      where: { name: "bootstrap" },
      orderBy: { createdAt: "asc" },
    });
    if (rows.length > 1) {
      await prisma.apiToken.deleteMany({
        where: { id: { in: rows.slice(1).map((r) => r.id) } },
      });
    }
  });

  it("is idempotent: no duplicate bootstrap token created on repeat calls", async () => {
    const appTokenHash = await import("../../src/lib/config").then((m) =>
      // 直接使用 auth/tokens hashToken 保证一致
      import("../../src/modules/auth/tokens").then((t) =>
        t.hashToken(m.config.APP_BOOTSTRAP_TOKEN),
      ),
    );

    await ensureBootstrap();
    await ensureBootstrap();

    const duplicates = await prisma.apiToken.count({
      where: { tokenHash: appTokenHash },
    });
    expect(duplicates).toBe(1);

    // 默认租户存在
    const defaultTenant = await prisma.tenant.findFirst({
      where: { name: "default" },
      select: { id: true },
    });
    expect(defaultTenant).not.toBeNull();
  });
});

describe("tenant isolation helpers", () => {
  it("creates isolated tenants and cleans them up completely", async () => {
    const a = await createTestTenant("iso-a");
    const b = await createTestTenant("iso-b");
    expect(a.id).not.toBe(b.id);
    // task.owner_token_id 必填：先为租户 a 签发一个 token 作归属
    const tok = await createTestToken(a.id, []);
    await prisma.task.create({
      data: {
        name: "iso-task",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: [],
        notifyOn: [],
        nextRunAt: new Date(),
        tenantId: a.id,
        ownerTokenId: tok.id,
      },
    });
    const countA = await prisma.task.count({ where: { tenantId: a.id } });
    const countB = await prisma.task.count({ where: { tenantId: b.id } });
    expect(countA).toBeGreaterThan(countB);
    await cleanupTenant(a.id);
    await cleanupTenant(b.id);
    expect(await prisma.tenant.count({ where: { id: a.id } })).toBe(0);
    expect(await prisma.task.count({ where: { tenantId: a.id } })).toBe(0);
  });
});
