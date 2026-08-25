import { DateTime } from "luxon";

/**
 * 对外时间序列化：存储层保持 UTC（连接串 timezone=Z，见 CLAUDE.md 时区约定），
 * 接口传输统一输出北京时间（Asia/Shanghai）的带偏移 ISO 8601。
 * 例：2026-08-25T02:00:00.000Z → "2026-08-25T10:00:00.000+08:00"
 * 带偏移字符串无歧义：人眼直读北京时间；new Date() 在任何环境解析回同一时刻。
 */
const API_TIMEZONE = "Asia/Shanghai";

/** Date → "YYYY-MM-DDTHH:mm:ss.SSS+08:00"（北京时间墙钟 + 显式偏移后缀）。 */
export function toBeijingIso(date: Date): string {
  // ZZ 输出形如 "+08:00" 的偏移；用 toFormat 固定毫秒位数，保证契约格式稳定。
  return DateTime.fromJSDate(date).setZone(API_TIMEZONE).toFormat("yyyy-MM-dd'T'HH:mm:ss.SSSZZ");
}

/**
 * 深度遍历响应体：Date 实例 → 带偏移 ISO 字符串，其余原样返回。
 * 仅递归普通对象与数组；Buffer/类实例等非普通对象整体透传，避免被拆散。
 */
export function serializeDates(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  if (value instanceof Date) return toBeijingIso(value);
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return null; // 环引用兜底（Prisma 行不会出现）：断环防栈溢出
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => walk(item, seen));
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return value;
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = walk(val, seen);
  }
  return out;
}
