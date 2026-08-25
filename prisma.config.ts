import "dotenv/config";
import { defineConfig, env } from "prisma/config";

/**
 * Prisma 7 配置：连接 URL 移至此处（schema 中不再允许 url）。
 * CLI（migrate/generate）读取；运行时 @prisma/client 经 driver adapter 直连。
 */
export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    url: env("DATABASE_URL"),
  },
});