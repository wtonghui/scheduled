/**
 * 中继公平取批纯函数（P1-3，多 pod 版）：
 * - 各 pod 独立算出轮询顺序，无共享状态、无时钟假设（随机起点，各 pod 自然错峰；
 *   同起点冲突由 outbox 认领（updateMany 条件更新）去重，只多几次空抢）。
 * - 单租户时数学上恒等于 FIFO 全取，行为不变。
 * - 语义是“租户内 FIFO”，非全局 FIFO。
 */

/** 每租户份额：至少 1 条，向上取整。 */
export function perTenantShare(limit: number, tenantCount: number): number {
  if (tenantCount <= 0) {
    return limit;
  }
  return Math.max(1, Math.ceil(limit / tenantCount));
}

/** 随机起点下标（uniform 0..count-1；空表回 0）。 */
export function pickStart(count: number): number {
  if (count <= 0) {
    return 0;
  }
  return Math.floor(Math.random() * count);
}

/** 从起点轮转一圈：order[(start+i) % n]。 */
export function rotatedOrder<T>(items: T[], start: number): T[] {
  if (items.length === 0) {
    return [];
  }
  const s = ((start % items.length) + items.length) % items.length;
  return [...items.slice(s), ...items.slice(0, s)];
}
