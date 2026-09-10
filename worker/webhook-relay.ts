import { decryptSecret } from "../src/lib/crypto";
import { prisma } from "../src/lib/db";
import { HttpError } from "../src/lib/errors";
import { logger } from "../src/lib/logger";
import { classifyError, jitteredDelayMs } from "../src/lib/retry";
import { checkUrlForSsrf } from "../src/lib/ssrf";
import { signWebhook } from "../src/modules/webhook/signature";

/**
 * Webhook 中继（FR-016 / contracts 投递契约）：
 * 轮询 webhook_delivery(pending) → POST payload + `X-Scheduled-Signature: t/v1`。
 * 2xx sent；429/5xx/超时重试；4xx 永久 failed；耗尽 dead。run_id 唯一幂等。
 * 认领后崩溃遗留的 in_progress（updatedAt 超过阈值）会被回收重投，避免静默丢失。
 */

/** in_progress 回收阈值：认领后 10 分钟仍未终态视为认领者已死（中继节拍秒级，正常投递远快于此）。 */
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000;

export async function runWebhookRelayOnce(limit = 20): Promise<number> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_IN_PROGRESS_MS);
  const rows = await prisma.webhookDelivery.findMany({
    where: {
      OR: [
        {
          status: { in: ["pending"] },
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
        },
        { status: "in_progress", updatedAt: { lt: staleBefore } },
      ],
    },
    orderBy: { id: "asc" },
    take: limit,
  });

  let delivered = 0;
  for (const row of rows) {
    const claimed = await prisma.webhookDelivery.updateMany({
      where: {
        id: row.id,
        OR: [{ status: "pending" }, { status: "in_progress", updatedAt: { lt: staleBefore } }],
      },
      data: { status: "in_progress" },
    });
    if (claimed.count === 0) {
      continue;
    }
    if (row.status === "in_progress") {
      logger.warn({ run_id: row.runId }, "reclaimed stale in_progress webhook, redelivering");
    }

    try {
      const ssrf = await checkUrlForSsrf(row.webhookUrl);
      if (!ssrf.ok) {
        throw new Error(`webhook url blocked: ${ssrf.reason}`);
      }

      // 复用签名前的原始 body，确保 HMAC 覆盖投递字节
      const body = typeof row.payload === "string" ? row.payload : JSON.stringify(row.payload);
      const secret = row.webhookSecret ? decryptSecret(new Uint8Array(row.webhookSecret)) : "";
      const signature = signWebhook(body, secret);

      const res = await fetch(row.webhookUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-scheduled-signature": signature,
        },
        body,
      });

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
        continue;
      }
      if (res.status === 429 || res.status >= 500) {
        throw new HttpError(res.status, `webhook responded ${res.status}`);
      }
      // 4xx → 永久失败
      throw new HttpError(res.status, `webhook responded ${res.status} (permanent)`);
    } catch (error) {
      const attempts = row.attempts + 1;
      const base = { attempts, lastError: (error as Error).message };
      const permanent = classifyError(error) === "permanent" || row.attempts + 1 >= row.maxAttempts;
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
    }
  }
  return delivered;
}
