import "dotenv/config";
import { prisma } from "../src/lib/db";
import { logger } from "../src/lib/logger";
import { ensureBootstrap } from "../src/modules/tenant/service";

/**
 * 种子（quickstart.md §1）：
 * 仅引导 default 租户 + 默认管理 token（APP_BOOTSTRAP_TOKEN 哈希，幂等）。
 * 不插入任何示例/冒烟任务（任务由用户通过 API/控制台创建）。
 */
async function seed(): Promise<void> {
  await ensureBootstrap();
  logger.info("seed: done (default tenant + bootstrap token ensured, no task inserted)");
}

seed()
  .catch((error) => {
    logger.error({ err: error }, "seed failed");
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
