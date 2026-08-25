/**
 * tsx 运行时回归:cron-parser 的 CJS/ESM 互操作。
 *
 * 背景:vitest 的加载器互操作正常,单测全绿;但真实 worker 进程(tsx/Node 原生
 * ESM 加载器)可能拿不到 cron-parser 的命名导出,导致 parseCron 抛错被吞、
 * computeNextRun 恒返回 null → 任务跑完一次即被自动停用(enabled=0)。
 *
 * 本脚本用与 worker 相同的 tsx 加载方式执行,是该失败模式的防线:
 *   npm run test:runtime
 */
import { computeNextRun, isValidCron, nextRunAt } from "../src/lib/cron";

const failures: string[] = [];

function assert(cond: boolean, message: string): void {
  if (!cond) {
    failures.push(message);
  }
}

// 合法 cron:必须解析通过,且能算出下一次运行时间
assert(
  isValidCron("*/5 * * * *"),
  'isValidCron("*/5 * * * *") 应为 true(命名导出为空的互操作 bug 会使其为 false)',
);

const next = computeNextRun({ cron: "*/5 * * * *", scheduleIntervalSeconds: null }, new Date());
assert(
  next instanceof Date && next.getTime() > Date.now(),
  `computeNextRun("*/5 * * * *") 应返回未来时间,实际=${String(next)}`,
);

// 6 段(含秒)合法 cron
assert(isValidCron("0 25 6 * * *"), '六段 cron "0 25 6 * * *" 应为 true');

// 永无未来运行点的合法表达式("2月30日"):应返回 null(触发自动停用的语义)而不是抛错
const never = nextRunAt("0 0 30 2 *");
assert(
  never === null,
  `nextRunAt("0 0 30 2 *") 应为 null(2月30日无未来运行点),实际=${String(never)}`,
);

if (failures.length > 0) {
  console.error(`[check-cron-runtime] FAILED:\n - ${failures.join("\n - ")}`);
  process.exit(1);
}

console.log("[check-cron-runtime] OK: cron-parser 在 tsx 运行时下解析正常");
