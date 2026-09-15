import { decryptSecret } from "../src/lib/crypto";
import { config } from "../src/lib/config";
import { prisma } from "../src/lib/db";
import { HttpError, TimeoutError } from "../src/lib/errors";
import { logger } from "../src/lib/logger";
import { classifyError, jitteredDelayMs } from "../src/lib/retry";
import { webhookSentTotal, webhookFailedTotal, webhookBreakersOpen } from "../src/lib/metrics";
import { MAX_REDIRECTS, checkUrlForSsrf } from "../src/lib/ssrf";
import { signWebhook } from "../src/modules/webhook/signature";
import { createPool } from "../src/lib/concurrency";
import { perTenantShare, pickStart, rotatedOrder } from "../src/lib/fairness";

/**
 * Webhook 中继（FR-016 / contracts 投递契约）：
 * 轮询 webhook_delivery(pending) → POST payload + `X-Scheduled-Signature: t/v1`。
 * 2xx sent；429/5xx/超时重试；4xx 永久 failed；耗尽 dead。run_id 唯一幂等。
 * 认领后崩溃遗留的 in_progress（updatedAt 超过阈值）会被回收重投，避免静默丢失。
 */

/** in_progress 回收阈值：默认 10 分钟（OUTBOX_STALE_MS 可配），认领后超期未终态视为认领者已死。 */
const STALE_IN_PROGRESS_MS = config.OUTBOX_STALE_MS;

/** 单次投递超时：默认 15s（WEBHOOK_FETCH_TIMEOUT_MS 可配），单个 hung 下游不卡死整轮。 */
const WEBHOOK_FETCH_TIMEOUT_MS = config.WEBHOOK_FETCH_TIMEOUT_MS;

/** 中继并发（webhook 池，RELAY_WEBHOOK_CONCURRENCY 可配）：与邮件池分离。 */
const RELAY_CONCURRENCY = config.RELAY_WEBHOOK_CONCURRENCY;

/**
 * 熔断存储缝（P1-3，多 pod 设计）：
 * 调用方只认 BreakerStore 接口，不认实现。现在是内存实现——多 pod 下各 pod
 * 独立熔断 + 抖动冷却错峰（Envoy outlier-detection 同款语义：熔断本就是建议，
 * 各 pod 交一点学费可接受，换零协调零单点）。
 * 后续 Redis 版实现同一接口（SET NX + TTL，天然带过期），config 切后端即可，
 * 调用点不动；Redis 挂了走 fail-open（当无熔断），通知不断流。
 */
export interface BreakerStore {
  isOpen(host: string, now: number): boolean;
  openUntil(host: string): number;
  onSuccess(host: string): void;
  onFailure(host: string, now: number): void;
}

export class MemoryBreakerStore implements BreakerStore {
  private readonly states = new Map<string, { fails: number; openUntil: number }>();

  constructor(
    private readonly threshold = config.RELAY_BREAKER_THRESHOLD,
    private readonly cooldownMs = config.RELAY_BREAKER_COOLDOWN_MS,
  ) {}

  isOpen(host: string, now: number): boolean {
    const s = this.states.get(host);
    // 未达阈值：计数保留（此前实现读一次删一次，计数永不到阈值、熔断恒不开）
    if (!s || s.fails < this.threshold) {
      return false;
    }
    if (s.openUntil <= now) {
      this.states.delete(host);
      webhookBreakersOpen.set(this.countOpen(now));
      return false;
    }
    return true;
  }

  openUntil(host: string): number {
    return this.states.get(host)?.openUntil ?? 0;
  }

  onSuccess(host: string): void {
    if (this.states.delete(host)) {
      webhookBreakersOpen.set(this.countOpen(Date.now()));
    }
  }

  onFailure(host: string, now: number): void {
    const s = this.states.get(host) ?? { fails: 0, openUntil: 0 };
    s.fails += 1;
    if (s.fails >= this.threshold && s.openUntil <= now) {
      // 抖动冷却：多 pod 同一批失败不再同毫秒恢复，错峰重试防二次踩踏
      s.openUntil = now + this.cooldownMs * (0.8 + 0.4 * Math.random());
      logger.warn(
        { host, fails: s.fails, openUntil: s.openUntil },
        "webhook breaker opened for host",
      );
    }
    this.states.set(host, s);
    webhookBreakersOpen.set(this.countOpen(now));
  }

  private countOpen(now: number): number {
    let n = 0;
    for (const [h, s] of this.states) {
      if (s.openUntil > now) {
        n += 1;
      } else if (s.fails >= this.threshold) {
        this.states.delete(h); // 过期熔断懒清理
      }
    }
    return n;
  }
}

/** 进程内单例（多 pod 下各 pod 独立一份 + 抖动错峰）。 */
export const webhookBreaker: BreakerStore = new MemoryBreakerStore();
/** 同 host 在途计数：防单个慢下游占满全局池，超限的行留到下轮。 */
const hostActive = new Map<string, number>();

function hostOf(url: string): string | null {
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * SSRF 失败分两类：结构/黑名单命中→永久（直接 dead，不浪费重试）；
 * DNS 瞬断/解析空→可重试（503 HttpError 进 failed+退避）。
 */
function throwSsrfError(prefix: string, reason: string): never {
  if (/dns resolution failed|no addresses resolved/i.test(reason)) {
    throw new HttpError(503, `${prefix}: transient dns failure (${reason})`);
  }
  throw new Error(`${prefix}: ${reason}`);
}

/**
 * 投递 webhook：手动跟随重定向（≤MAX_REDIRECTS）且逐跳 SSRF 复核，每跳独立超时。
 * fetch 默认跟随重定向会绕过初始 SSRF 校验，此处与 http 执行器同策略。
 * 超时（DOM AbortError）统一转自定义 TimeoutError，保证 classifyError 判可重试。
 */
async function postWebhook(url: string, body: string, signature: string): Promise<Response> {
  let current = url;
  for (let hop = 0; ; hop += 1) {
    let res: Response;
    try {
      res = await fetch(current, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scheduled-signature": signature,
        },
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(WEBHOOK_FETCH_TIMEOUT_MS),
      });
    } catch (error) {
      const name = (error as { name?: string }).name ?? "";
      if (name === "TimeoutError" || name === "AbortError" || (error as Error).message?.includes("timeout")) {
        throw new TimeoutError(`webhook fetch timed out after ${WEBHOOK_FETCH_TIMEOUT_MS}ms`);
      }
      throw error;
    }
    if (res.status < 300 || res.status >= 400) {
      return res;
    }
    const location = res.headers.get("location");
    if (!location) {
      return res;
    }
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`too many redirects (max ${MAX_REDIRECTS})`);
    }
    const nextUrl = new URL(location, current).toString();
    const hopCheck = await checkUrlForSsrf(nextUrl);
    if (!hopCheck.ok) {
      throwSsrfError("redirect blocked by ssrf policy", hopCheck.reason);
    }
    current = nextUrl;
  }
}

/**
 * 公平取批（P1-3，多 pod 设计）：stale in_progress 优先（safety 通道，不受公平限制）；
 * 其余按租户 groupBy → 随机起点轮询 → 每家 ceil(剩余/家数) 条，租户内按 id FIFO。
 * 各 pod 独立算顺序（无共享状态、无时钟假设；单租户恒等于 FIFO 全取）；
 * 同起点冲突由认领（updateMany 条件更新）去重。语义是“租户内 FIFO”，非全局 FIFO。
 */
async function pickWebhookBatch(limit: number, staleBefore: Date, now: Date) {
  const stale = await prisma.webhookDelivery.findMany({
    where: {
      status: "in_progress",
      OR: [
        // 显式 deadline（认领时写入 = Redis TTL 语义）：只看它
        { nextRetryAt: { lte: now } },
        // 发版前遗留行（无 deadline）：updatedAt 回退一个窗口，之后自然排空
        { nextRetryAt: null, updatedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { id: "asc" },
    take: limit,
  });
  const rows = [...stale];
  if (rows.length >= limit) {
    return rows;
  }
  const groups = await prisma.webhookDelivery.groupBy({
    by: ["tenantId"],
    where: {
      OR: [
        {
          status: { in: ["pending"] },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        // 可重试失败：status=failed 且到重试时刻
        { status: "failed", nextRetryAt: { lte: now } },
      ],
    },
    _count: { tenantId: true },
  });
  if (groups.length === 0) {
    return rows;
  }
  const order = rotatedOrder(
    groups.map((g) => g.tenantId),
    pickStart(groups.length),
  );
  const share = perTenantShare(limit - rows.length, order.length);
  for (const tenantId of order) {
    const room = limit - rows.length;
    if (room <= 0) {
      break;
    }
    const batch = await prisma.webhookDelivery.findMany({
      where: {
        tenantId,
        OR: [
          {
            status: { in: ["pending"] },
            OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
          },
          { status: "failed", nextRetryAt: { lte: now } },
        ],
      },
      orderBy: { id: "asc" },
      take: Math.min(share, room),
    });
    rows.push(...batch);
  }
  return rows;
}

export async function runWebhookRelayOnce(limit = config.RELAY_BATCH_SIZE): Promise<number> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_IN_PROGRESS_MS);
  const rows = await pickWebhookBatch(limit, staleBefore, now);

  let delivered = 0;
  // 并发队列语义：pool.run 一次性入队，p-limit 保证最多 N 个同时跑，
  // 完成一个即补下一个；allSettled 只做 join，单行爆不影响整批。
  const pool = createPool(RELAY_CONCURRENCY);
  await Promise.allSettled(
    rows.map((row) =>
      pool.run(async () => {
        // 熔断/按域限流在认领前判定：熔断中的 host 直接推后 nextRetryAt，不占并发槽；
        // 同 host 在途超限留到下轮，防单个慢下游占满全局池。
        const host = hostOf(row.webhookUrl);
        if (host && webhookBreaker.isOpen(host, Date.now())) {
          const until = webhookBreaker.openUntil(host);
          if (until > 0) {
            await prisma.webhookDelivery
              .updateMany({
                where: { id: row.id, status: { in: ["pending", "failed"] } },
                data: { nextRetryAt: new Date(until) },
              })
              .catch(() => {});
          }
          return;
        }
        if (host && (hostActive.get(host) ?? 0) >= config.RELAY_PER_HOST_LIMIT) {
          return;
        }
        const claimed = await prisma.webhookDelivery.updateMany({
          where: {
            id: row.id,
            OR: [
              { status: "pending" },
              { status: "failed", nextRetryAt: { lte: new Date() } },
              {
                status: "in_progress",
                OR: [
                  { nextRetryAt: { lte: new Date() } },
                  { nextRetryAt: null, updatedAt: { lt: staleBefore } },
                ],
              },
            ],
          },
          // 显式认领 deadline（= Redis TTL 语义）：回收只看它，不看 updatedAt
          data: {
            status: "in_progress",
            nextRetryAt: new Date(Date.now() + STALE_IN_PROGRESS_MS),
          },
        });
        if (claimed.count === 0) {
          return;
        }
        if (host) {
          hostActive.set(host, (hostActive.get(host) ?? 0) + 1);
        }
        if (row.status === "in_progress") {
          logger.warn({ run_id: row.runId }, "reclaimed stale in_progress webhook, redelivering");
        }
        try {
      const ssrf = await checkUrlForSsrf(row.webhookUrl);
      if (!ssrf.ok) {
        throwSsrfError("webhook url blocked", ssrf.reason);
      }

      // 复用签名前的原始 body，确保 HMAC 覆盖投递字节
      const body = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
      const secret = row.webhookSecret ? decryptSecret(new Uint8Array(row.webhookSecret)) : "";
      const signature = signWebhook(body, secret);

      const res = await postWebhook(row.webhookUrl, body, signature);

      if (res.status >= 200 && res.status < 300) {
        await prisma.webhookDelivery.update({
          where: { id: row.id },
          data: {
            status: "sent",
            sentAt: new Date(),
            signature,
            responseCode: res.status,
            attempts: { increment: 1 },
          },
        });
        delivered += 1;
        webhookSentTotal.inc();
        if (host) {
          webhookBreaker.onSuccess(host);
        }
        return;
      }
      if (res.status === 429 || res.status >= 500) {
        throw new HttpError(res.status, `webhook responded ${res.status}`);
      }
      // 4xx → 永久失败
      throw new HttpError(res.status, `webhook responded ${res.status} (permanent)`);
    } catch (error) {
      const attempts = row.attempts + 1;
      const base = { attempts, lastError: (error as Error).message };
      webhookFailedTotal.inc();
      const retryable = classifyError(error) === "retryable";
      // 仅可重试失败计入熔断（永久 4xx/黑名单说明下游活着，不熔断）
      if (host && retryable) {
        webhookBreaker.onFailure(host, Date.now());
      }
      const permanent = !retryable || row.attempts + 1 >= row.maxAttempts;
      if (permanent) {
        await prisma.webhookDelivery.update({
          where: { id: row.id },
          data: { ...base, status: "dead" },
        });
        logger.error({ run_id: row.runId, attempts }, "webhook dead-lettered");
      } else {
        // 可重试失败：记 warn（此前静默，只有死信才有日志）
        logger.warn(
          { run_id: row.runId, attempts, err: (error as Error).message },
          "webhook delivery failed, will retry",
        );
        await prisma.webhookDelivery.update({
          where: { id: row.id },
          data: {
            ...base,
            status: "failed",
            nextRetryAt: new Date(Date.now() + jitteredDelayMs(2000, 2, 60000, attempts - 1)),
          },
        });
      }
      } finally {
        if (host) {
          hostActive.set(host, Math.max(0, (hostActive.get(host) ?? 1) - 1));
        }
      }
      }),
    ),
  );
  return delivered;
}
