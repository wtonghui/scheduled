import { PrismaMariaDb } from "@prisma/adapter-mariadb";
import { PrismaClient } from "@prisma/client";
import { config } from "./config";

/**
 * Prisma client 单例（Prisma 7 driver-adapter 模式）。
 * - adapter 经 mariadb 驱动直连 MySQL（MySQL 8 兼容），连接参数取 DATABASE_URL。
 * - web 进程（Next.js）：模块级单例，避免 HMR 重复实例。
 * - worker 进程：直连，connectionLimit ≈ 2 × 并发槽（DATABASE_URL 携带；mariadb 驱动只认 camelCase，下划线 connection_limit 无效）。
 * - 只读列表不走 $transaction（见 repository.ts），避免事务 maxWait 抢池造成 P2028。
 */
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

function createClient(): PrismaClient {
  const adapter = new PrismaMariaDb(config.DATABASE_URL);
  return new PrismaClient({
    adapter,
    log: config.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });
}

export const prisma: PrismaClient = globalForPrisma.prisma ?? createClient();

if (config.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
