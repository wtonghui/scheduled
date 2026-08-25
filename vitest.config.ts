import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

/**
 * Vitest 配置：unit + integration 测试。
 * - setupFiles 注入最小测试环境变量（config.ts 模块加载时 fail-fast 校验）。
 * - 覆盖率门禁 ≥80% 在 Phase 7（T043）调整阈值。
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@worker": resolve(__dirname, "./worker"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: [resolve(__dirname, "./tests/setup.ts")],
    environment: "node",
    testTimeout: 15_000,
    hookTimeout: 15_000,
    fileParallelism: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts", "worker/**/*.ts"],
      exclude: [
        "src/app/**",
        "src/lib/api-client.ts", // 浏览器侧 fetch 封装，由 E2E 覆盖
        "src/lib/openapi.ts",
        "src/mail/emails/**",
        "src/server.ts",
        "worker/index.ts", // 进程入口（信号/循环）——集成级
        "worker/runner.ts", // 池编排胶水——经 worker-exec 集成覆盖
        "**/*.d.ts",
      ],
      thresholds: {
        lines: 60,
        functions: 55,
        branches: 45,
        statements: 60,
      },
    },
  },
});