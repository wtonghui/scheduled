import "dotenv/config";
import { computeNextRun } from "../src/lib/cron";
import { prisma } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { ensureBootstrap } from "../src/modules/tenant/service";

/**
 * 种子（quickstart.md §1）：
 * 1. 首个租户 + 首个管理 token（APP_BOOTSTRAP_TOKEN 哈希，幂等）。
 * 2. 若无任务，插入一个 noop 冒烟任务（每 2 分钟执行）。
 */
async function seed(): Promise<void> {
  await ensureBootstrap();

  const existing = await prisma.task.count();
  if (existing === 0) {
    const tenant = await prisma.tenant.findFirst();
    if (!tenant) {
      throw new Error("seed: no tenant found after bootstrap");
    }
    // 冒烟任务必须可执行(next_run_at 非空),否则会变成 enabled=1 但对领取查询不可见的僵尸任务
    const smokeNextRun = computeNextRun({ cron: "*/2 * * * *" });
    if (!smokeNextRun) {
      throw new Error("seed: smoke-noop cron 计算不出未来运行点(检查 cron-parser 加载/表达式)");
    }
    // owner_token_id 必填：冒烟任务归 bootstrap token（该租户最早签发）
    const bootstrapToken = await prisma.apiToken.findFirst({
      where: { tenantId: tenant.id },
      orderBy: { createdAt: "asc" },
    });
    if (!bootstrapToken) {
      throw new Error("seed: bootstrap token missing after ensureBootstrap");
    }
    await prisma.task.create({
      data: {
        name: "smoke-noop",
        cron: "*/2 * * * *",
        taskType: "noop",
        payload: {},
        recipients: [],
        notifyOn: [],
        nextRunAt: smokeNextRun,
        tenantId: tenant.id,
        ownerTokenId: bootstrapToken.id,
      },
    });
    logger.info("seed: inserted smoke-noop task");
  }

  logger.info("seed: done");
}

seed()
  .catch((error) => {
    logger.error({ err: error }, "seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
