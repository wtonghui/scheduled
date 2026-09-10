import { DateTime } from "luxon";
import { config } from "./config";
import { logger } from "./logger";

/**
 * 节假日模块：唯一碰节假日 API 的地方。
 * API 形状变化只改 parseHolidayResponse；调用方只认 boolean | null。
 *
 * 假设A 契约：
 *   请求 POST {HOLIDAY_API_URL}?appKey={HOLIDAY_API_APP_KEY}
 *   body {"params": {"natural_day": "YYYYMMDD"}}（natural_day 按任务时区墙钟日期）
 *   响应 {"code": 0, "data": {"isHoliday": true, "name": "国庆节"}}
 *   code 非 0 / 缺字段 / 解析失败 / 超时 / 连不通 → null（未知）。
 */

export type HolidayPolicy = "drop" | "postpone";

/** 假日推进循环上限（天）：防脏数据（天天是假日）把任务停光，超界 fail-open。 */
const MAX_HOLIDAY_LOOKAHEAD_DAYS = 366;

/** isHoliday 缓存 TTL：24h（假日日历日内不变）。 */
const HOLIDAY_CACHE_TTL_MS = 24 * 3600 * 1000;

interface CacheEntry {
  value: boolean;
  expires: number;
}

const cache = new Map<string, CacheEntry>();
/** 并发去重：同 natural_day 同 tick 只发一次请求。 */
const inflight = new Map<string, Promise<boolean | null>>();

/** Date → natural_day（按任务时区墙钟日期，格式 YYYYMMDD）。 */
export function toNaturalDay(date: Date, timezone: string): string {
  return DateTime.fromJSDate(date).setZone(timezone).toFormat("yyyyMMdd");
}

/**
 * 解析节假日 API 响应（形状变化只改这里）。
 * {"code": 0, "data": {"isHoliday": true}} → true/false；其他一切 → null。
 */
export function parseHolidayResponse(json: unknown): boolean | null {
  if (!json || typeof json !== "object") {
    return null;
  }
  const root = json as Record<string, unknown>;
  if (root.code !== 0) {
    return null;
  }
  const data = root.data;
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return null;
  }
  const flag = (data as Record<string, unknown>).isHoliday;
  return typeof flag === "boolean" ? flag : null;
}

/** 节假日 API 是否配好（URL+KEY 缺任一即未启用）。 */
export function isHolidayConfigured(): boolean {
  return !!(config.HOLIDAY_API_URL && config.HOLIDAY_API_APP_KEY);
}

/** 查某天是否假日；未知（未配置/失败）→ null，调用方按工作日处理（fail-open）。 */
export async function isHoliday(
  naturalDay: string,
  opts?: { url?: string; appKey?: string; timeoutMs?: number },
): Promise<boolean | null> {
  const url = opts?.url ?? config.HOLIDAY_API_URL;
  const appKey = opts?.appKey ?? config.HOLIDAY_API_APP_KEY;
  if (!url || !appKey) {
    return null;
  }
  const timeoutMs = opts?.timeoutMs ?? config.HOLIDAY_API_TIMEOUT_MS;
  const now = Date.now();
  const hit = cache.get(naturalDay);
  if (hit && hit.expires > now) {
    return hit.value;
  }
  const ongoing = inflight.get(naturalDay);
  if (ongoing) {
    return ongoing;
  }
  const pending = queryHolidayApi(naturalDay, url, appKey, timeoutMs).finally(() => {
    inflight.delete(naturalDay);
  });
  inflight.set(naturalDay, pending);
  const result = await pending;
  if (result !== null) {
    cache.set(naturalDay, { value: result, expires: now + HOLIDAY_CACHE_TTL_MS });
  }
  return result;
}

async function queryHolidayApi(
  naturalDay: string,
  baseUrl: string,
  appKey: string,
  timeoutMs: number,
): Promise<boolean | null> {
  try {
    const url = `${baseUrl}?appKey=${encodeURIComponent(appKey)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ params: { natural_day: naturalDay } }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      logger.warn({ naturalDay, status: res.status }, "holiday api non-200, treated as workday");
      return null;
    }
    const json = (await res.json()) as unknown;
    const parsed = parseHolidayResponse(json);
    if (parsed === null) {
      logger.warn({ naturalDay }, "holiday api unparseable, treated as workday");
    }
    return parsed;
  } catch (error) {
    logger.warn(
      { naturalDay, err: (error as Error).message },
      "holiday api failed, treated as workday",
    );
    return null;
  }
}

/**
 * 假日调整：候选时刻落在假日则按策略推进。
 * drop → 取之后下一个调度点（nextAfter）；postpone → 同墙钟+1天。
 * 超 366 天还没工作日 → fail-open 返回原值 + error 日志。
 */
export async function adjustForHolidays(opts: {
  candidate: Date | null;
  policy: HolidayPolicy;
  timezone: string;
  nextAfter: (d: Date) => Date | null;
  /** 测试注入；默认走真实 isHoliday（含缓存）。 */
  isHolidayFn?: (naturalDay: string) => Promise<boolean | null>;
}): Promise<Date | null> {
  const { policy, timezone, nextAfter, isHolidayFn = isHoliday } = opts;
  let current = opts.candidate;
  if (!current) {
    return null;
  }
  for (let i = 0; i < MAX_HOLIDAY_LOOKAHEAD_DAYS; i += 1) {
    const holiday = await isHolidayFn(toNaturalDay(current, timezone));
    // null（未知）按工作日处理：宁可假日误跑一次，不停调度
    if (holiday !== true) {
      return current;
    }
    if (policy === "postpone") {
      current = DateTime.fromJSDate(current).setZone(timezone).plus({ days: 1 }).toJSDate();
    } else {
      current = nextAfter(current);
      if (!current) {
        return null;
      }
    }
  }
  logger.error(
    { candidate: opts.candidate?.toISOString(), policy },
    "holiday lookahead exceeded, fail-open",
  );
  return opts.candidate;
}

/** 测试用：清空缓存与并发态。 */
export function __clearHolidayCacheForTest(): void {
  cache.clear();
  inflight.clear();
}
