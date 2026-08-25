import { prisma } from "@/lib/db";
import { hashToken } from "@/modules/auth/tokens";
import { config } from "@/lib/config";
import { logger } from "@/lib/logger";

/**
 * Tenant 服务：多租户隔离（FR-015）。
 * - ensureBootstrap：表空时创建首个租户 + 首个管理 token（APP_BOOTSTRAP_TOKEN 哈希）。
 * - 所有资源查询按 tenant_id 过滤，跨租户 404。
 */

export async function ensureBootstrap(): Promise<void> {
  const tenantCount = await prisma.tenant.count();

  if (tenantCount === 0) {
    const tenant = await prisma.tenant.create({ data: { name: "default" } });
    await prisma.apiToken.create({
      data: {
        tokenHash: hashToken(config.APP_BOOTSTRAP_TOKEN),
        prefix: config.APP_BOOTSTRAP_TOKEN.slice(0, 8),
        lastFour: config.APP_BOOTSTRAP_TOKEN.slice(-4),
        name: "bootstrap",
        scopes: ["tokens:manage"],
        tenantId: tenant.id,
      },
    });
    logger.info("tenant bootstrap: created default tenant + bootstrap token");
    return;
  }

  // 租户已存在但无任何 token → 为第一个租户补建管理 token（幂等）
  const tokenCount = await prisma.apiToken.count();
  if (tokenCount === 0) {
    const firstTenant = await prisma.tenant.findFirst();
    if (firstTenant) {
      await prisma.apiToken.create({
        data: {
          tokenHash: hashToken(config.APP_BOOTSTRAP_TOKEN),
          prefix: config.APP_BOOTSTRAP_TOKEN.slice(0, 8),
          lastFour: config.APP_BOOTSTRAP_TOKEN.slice(-4),
          name: "bootstrap",
          scopes: ["tokens:manage"],
          tenantId: firstTenant.id,
        },
      });
      logger.info("tenant bootstrap: recreated bootstrap token for first tenant");
    }
  }
}

export async function createTenant(name: string) {
  return prisma.tenant.create({ data: { name } });
}

export async function getTenantById(id: string) {
  return prisma.tenant.findUnique({ where: { id } });
}