import cronParserDefault from "cron-parser";
import type { CronExpression } from "cron-parser";
import { Cron } from "croner";

/**
 * cron-parser 是 CJS 包,tsx/Node 原生 ESM 加载器只把 module.exports 暴露为 default
 * (命名导出为空),vitest/esbuild 则两者皆可。统一解析一次,防止在 worker(tsx) 下
 * cronParser.parseExpression 为 undefined —— 那会让 parseCron 抛错被吞、computeNextRun
 * 恒返回 null,任务跑一次即被自动停用(enabled=0),而 vitest 单测却一切正常。
 */
type CronParserApi = { parseExpression: typeof import("cron-parser").parseExpression };

function resolveCronParser(): CronParserApi {
  const direct = cronParserDefault as unknown as Partial<CronParserApi>;
  if (typeof direct.parseExpression === "function") {
    return direct as CronParserApi;
  }
  const nested = (cronParserDefault as unknown as { default?: Partial<CronParserApi> }).default;
  if (nested && typeof nested.parseExpression === "function") {
    return nested as CronParserApi;
  }
  throw new Error("cron-parser ESM/CJS 互操作失败:parseExpression 不可用");
}

const cronParser = resolveCronParser();

/** 默认时区（IANA）：项目统一按中国标准时间解析 cron 表达式。 */
export const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 校验 IANA 时区名（供 task DTO 的 timezone 字段使用）。 */
export function isValidTimezone(timezone: string): boolean {
  const value = timezone.trim();
  if (value.length === 0) {
    return false;
  }
  const intlValues = Intl as unknown as { supportedValuesOf?: (kind: string) => string[] };
  try {
    if (typeof intlValues.supportedValuesOf === "function") {
      // 注：部分 ICU 的列表不含 "UTC" 这类格式化合法的别名，命中即过、未命中继续构造校验
      if (intlValues.supportedValuesOf("timeZone").includes(value)) {
        return true;
      }
    }
    // 兜底：DateTimeFormat 构造校验（含 UTC 等别名；非法名直接抛 RangeError）
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * cron 解析/校验 + next_run_at 计算（FR-002，data-model.md）。
 * 支持 5/6/7 段表达式；默认按 DEFAULT_TIMEZONE，可透传任意 IANA 时区。
 * 5/6 段走 cron-parser；7 段（Quartz 式 `秒 分 时 日 月 周 年`）走 croner
 * （cron-parser v4/v5 均无年份字段，原地升级无法获得该能力）。
 */

export type ScheduleInput = {
  cron?: string | null;
  scheduleIntervalSeconds?: number | null;
};

/** 解析 5/6 段 cron 表达式；非法时抛错（供 zod refine 使用）。默认按 DEFAULT_TIMEZONE。7 段走 croner，见 nextRunAt。 */
export function parseCron(
  expression: string,
  from = new Date(),
  timezone = DEFAULT_TIMEZONE,
): CronExpression {
  return cronParser.parseExpression(expression, {
    currentDate: from,
    tz: timezone,
  });
}

export function isValidCron(expression: string): boolean {
  const trimmed = expression.trim();
  if (trimmed.length === 0) {
    return false;
  }
  // 标准 5 段（分 时 日 月 周）、6 段（含秒）或 7 段（Quartz 式，末位为年）
  const fields = trimmed.split(/\s+/);
  if (fields.length !== 5 && fields.length !== 6 && fields.length !== 7) {
    return false;
  }
  try {
    if (fields.length === 7) {
      // croner 构造成功即语法合法；年份已过这类"无未来运行"由 nextRunAt 返回 null
      // 表达（创建时 400 / 执行后自动停用），与"2 月 30 日"的既有语义一致
      new Cron(trimmed, { timezone: DEFAULT_TIMEZONE });
    } else {
      parseCron(trimmed);
    }
    return true;
  } catch {
    return false;
  }
}

/** 下次运行时间；无未来运行/表达式无有效目标 → null。 */
export function nextRunAt(
  expression: string,
  from = new Date(),
  timezone = DEFAULT_TIMEZONE,
): Date | null {
  try {
    if (expression.trim().split(/\s+/).length === 7) {
      // croner 原生支持年份字段：高频 + 远年（如每秒跑的 2099 年任务）也能直接定位，
      // 逐次 next() 迭代的朴素实现在此会爆炸，故不复用 cron-parser 路径
      return new Cron(expression.trim(), { timezone }).nextRun(from) ?? null;
    }
    const parsed = parseCron(expression, from, timezone);
    if (!parsed.hasNext()) {
      return null;
    }
    return parsed.next().toDate();
  } catch {
    return null; // 如 "0 0 30 2 *"（2 月无 30 日）→ 视为无未来运行
  }
}

/** 校验调度：cron 与 scheduleIntervalSeconds 必须恰有一个非空。 */
export function isValidSchedule(input: {
  cron?: string | null;
  scheduleIntervalSeconds?: number | null;
}): boolean {
  const hasCron = typeof input.cron === "string" && input.cron.length > 0;
  const hasInterval =
    typeof input.scheduleIntervalSeconds === "number" &&
    Number.isInteger(input.scheduleIntervalSeconds) &&
    (input.scheduleIntervalSeconds as number) > 0;
  return hasCron !== hasInterval && (hasCron || hasInterval);
}

/** 计算下次运行时间：cron 解析 next（按 timezone），固定间隔直接推进。 */
export function computeNextRun(
  input: ScheduleInput,
  from = new Date(),
  timezone = DEFAULT_TIMEZONE,
): Date | null {
  if (typeof input.cron === "string") {
    return nextRunAt(input.cron, from, timezone);
  }
  if (typeof input.scheduleIntervalSeconds === "number") {
    return new Date(from.getTime() + input.scheduleIntervalSeconds * 1000);
  }
  return null;
}
