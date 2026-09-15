import { prisma } from "../src/lib/db";
import { config } from "../src/lib/config";
import { getMailService, type MailAttachment } from "../src/mail/port";
import { classifyError, jitteredDelayMs } from "../src/lib/retry";
import { emailSentTotal, emailFailedTotal } from "../src/lib/metrics";
import { logger } from "../src/lib/logger";
import { checkUrlForSsrf, MAX_REDIRECTS } from "../src/lib/ssrf";
import { createPool } from "../src/lib/concurrency";
import { perTenantShare, pickStart, rotatedOrder } from "../src/lib/fairness";

/** 附件下载总超时（30s）：多跳转共用一把 abort，多跳不重置、不按跳叠加。 */
const ATTACHMENT_FETCH_TIMEOUT_MS = 30_000;

/**
 * 文件名清洗：去 query、解转义、只留最后一段、去控制字符与前导点、截断 128。
 * 拿不到合法名时回退 "attachment"（附件缺名不断联）。
 */
export function sanitizeAttachmentFilename(raw: string): string {
  let name = raw.split("?")[0] ?? "";
  try {
    name = decodeURIComponent(name);
  } catch {
    // 非法转义保留原文继续清洗
  }
  name = name.split("/").pop()?.split("\\").pop() ?? "";
  name = name.replace(/[\0-\x1f\x7f]/g, "").replace(/^\.+/, "").trim();
  if (name.length > 128) {
    name = name.slice(0, 128);
  }
  return name || "attachment";
}

/**
 * 从 URL 下载附件（SSRF 检查 + 手动跟随跳转且逐跳复核 + 分级内联）。
 * 分级（D 方案）：inlineMaxBytes 以内进内存贴附件；超限/0（纯链接模式）直接回 null
 * 走正文链接（renderTaskEmail 保证正文带 URL，见 service.tsx）。失败一律吞错回 null
 * （邮件照发），不污染中继状态机。
 * 与 webhook-relay 的 postWebhook 同跳转策略，但失败语义为吞错回 null（不进重试）。
 */
export async function downloadAttachment(
  url: string,
  inlineMaxBytes = config.ATTACHMENT_INLINE_MAX_BYTES,
): Promise<MailAttachment | null> {
  if (inlineMaxBytes <= 0) {
    return null; // 纯链接模式：不下载，正文里的 <a href> 即入口
  }
  const ssrf = await checkUrlForSsrf(url);
  if (!ssrf.ok) {
    logger.warn({ url, reason: ssrf.reason }, "attachment url blocked by SSRF policy");
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ATTACHMENT_FETCH_TIMEOUT_MS);
  try {
    let current = url;
    for (let hop = 0; ; hop += 1) {
      let res: Response;
      try {
        res = await fetch(current, { redirect: "manual", signal: controller.signal });
      } catch (error) {
        logger.warn({ url: current, err: (error as Error).message }, "attachment download error");
        return null;
      }
      const location = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !location) {
        try {
          return await toAttachment(res, url, inlineMaxBytes);
        } catch (error) {
          // 流式读超限/abort 等一律吞错回 null（邮件照发走链接），不进中继失败计数
          logger.warn(
            { url, err: (error as Error).message },
            "attachment read failed, sending without it",
          );
          return null;
        }
      }
      if (hop >= MAX_REDIRECTS) {
        logger.warn({ url, hops: hop + 1 }, "attachment too many redirects, skipping");
        return null;
      }
      let nextUrl: string;
      try {
        nextUrl = new URL(location, current).toString();
      } catch {
        logger.warn({ url: current, location }, "attachment bad redirect location, skipping");
        return null;
      }
      const hopCheck = await checkUrlForSsrf(nextUrl);
      if (!hopCheck.ok) {
        logger.warn(
          { url: nextUrl, reason: hopCheck.reason },
          "attachment redirect blocked by SSRF policy",
        );
        return null;
      }
      current = nextUrl;
    }
  } finally {
    clearTimeout(timer);
  }
}

/** 非跳转响应 → 附件（超内联上限/状态不合格回 null，走正文链接）。 */
async function toAttachment(
  res: Response,
  url: string,
  inlineMaxBytes: number,
): Promise<MailAttachment | null> {
  if (!res.ok) {
    logger.warn({ url, status: res.status }, "attachment download failed");
    return null;
  }
  const contentLength = Number(res.headers.get("content-length") ?? 0);
  if (contentLength > inlineMaxBytes) {
    // 长度可信时连 body 都不读，直接走链接（省带宽省槽位）
    logger.warn({ url, contentLength, inlineMaxBytes }, "attachment over inline limit, link only");
    return null;
  }
  // 流式计数：不信任 content-length（谎报时 arrayBuffer 会先吃满内存再判超）
  const reader = res.body?.getReader();
  if (!reader) {
    return null;
  }
  const chunks: Uint8Array[] = [];
  let received = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    received += value.byteLength;
    if (received > inlineMaxBytes) {
      await reader.cancel().catch(() => {});
      logger.warn({ url, received, inlineMaxBytes }, "attachment over inline limit, link only");
      return null;
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks);
  const contentType = res.headers.get("content-type") ?? undefined;
  return { filename: sanitizeAttachmentFilename(url), content: buf, contentType };
}

/**
 * 邮件中继（US3 独立测试场景）：轮询 email_log(pending) → MailService.send → 状态机。
 * 幂等：run_id UNIQUE（enqueue 侧）+ in_progress 乐观认领（本侧）。
 * payload 已持久化 html/text，不依赖任务行。
 * 认领后崩溃遗留的 in_progress（updatedAt 超过阈值）会被回收重投，避免静默丢失。
 */

/** in_progress 回收阈值：默认 10 分钟（OUTBOX_STALE_MS 可配），认领后超期未终态视为认领者已死。 */
const STALE_IN_PROGRESS_MS = config.OUTBOX_STALE_MS;

/** 中继并发（邮件池，RELAY_EMAIL_CONCURRENCY 可配）：SMTP 慢不拖 webhook。 */
const RELAY_CONCURRENCY = config.RELAY_EMAIL_CONCURRENCY;

/**
 * 公平取批（P1-3，多 pod 设计）：stale in_progress 优先（safety 通道，不受公平限制）；
 * 其余按租户 groupBy → 随机起点轮询 → 每家 ceil(剩余/家数) 条，租户内按 id FIFO。
 * 各 pod 独立算顺序（无共享状态、无时钟假设；单租户恒等于 FIFO 全取）；
 * 同起点冲突由认领（updateMany 条件更新）去重。语义是“租户内 FIFO”，非全局 FIFO。
 */
async function pickEmailBatch(limit: number, staleBefore: Date, now: Date) {
  const stale = await prisma.emailLog.findMany({
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
  const groups = await prisma.emailLog.groupBy({
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
    const batch = await prisma.emailLog.findMany({
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

export async function runEmailRelayOnce(limit = config.RELAY_BATCH_SIZE): Promise<number> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_IN_PROGRESS_MS);
  const rows = await pickEmailBatch(limit, staleBefore, now);

  let delivered = 0;
  // 并发队列语义：20 个 pool.run 一次性入队，p-limit 保证最多 5 个同时跑，
  // 完成一个即补下一个（不是“5个全完才下一批”）；allSettled 只做 join，单行爆不影响整批。
  const pool = createPool(RELAY_CONCURRENCY);
  await Promise.allSettled(
    rows.map((row) =>
      pool.run(async () => {
        const claimed = await prisma.emailLog.updateMany({
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
    if (row.status === "in_progress") {
      logger.warn({ run_id: row.runId }, "reclaimed stale in_progress email, redelivering");
    }

    // 失败时的 provider 回执（透传进 lastError 旁的 providerResponse 列，便于排障）
    let failedProviderResponse: string | undefined;
    try {
      const to = JSON.parse(row.toAddress) as string[];
      // 附件下载（有 attachment_url 才下载；失败不阻塞邮件投递）
      let attachments: MailAttachment[] | undefined;
      if (row.attachmentUrl) {
        const att = await downloadAttachment(row.attachmentUrl);
        if (att) {
          attachments = [att];
        }
      }
      const result = await getMailService().send({
        to,
        subject: row.subject,
        html: row.html ?? "",
        text: row.text ?? "",
        externalRef: row.runId,
        ...(attachments ? { attachments } : {}),
      });
      if (result.status !== "sent") {
        // 抛原始 error（P0-1 透传）：classifyError 据 code/responseCode 判重试还是死信；
        // 无透传时回退通用错误（= permanent，进 dead，老行为）。
        failedProviderResponse = result.providerResponse;
        throw (result.error ?? new Error("mail provider reported failure")) as Error;
      }
      await prisma.emailLog.update({
        where: { id: row.id },
        data: {
          status: "sent",
          sentAt: new Date(),
          messageId: result.messageId,
          providerResponse: result.providerResponse,
          attempts: { increment: 1 },
        },
      });
      delivered += 1;
      emailSentTotal.inc();
    } catch (error) {
      const attempts = row.attempts + 1;
      const base = {
        attempts,
        lastError: (error as Error).message,
        ...(failedProviderResponse ? { providerResponse: failedProviderResponse } : {}),
      };
      emailFailedTotal.inc();
      if (attempts >= row.maxAttempts) {
        await prisma.emailLog.update({
          where: { id: row.id },
          data: { ...base, status: "dead" },
        });
        logger.error({ run_id: row.runId, attempts }, "email dead-lettered");
      } else {
        const retryable = classifyError(error) === "retryable";
        if (retryable) {
          logger.warn(
            { run_id: row.runId, attempts, err: (error as Error).message },
            "email delivery failed, will retry",
          );
        }
        await prisma.emailLog.update({
          where: { id: row.id },
          data: {
            ...base,
            status: retryable ? "failed" : "dead",
            nextRetryAt: retryable
              ? new Date(Date.now() + jitteredDelayMs(2000, 2, 60000, attempts - 1))
              : null,
          },
        });
      }
    }
      }),
    ),
  );
  return delivered;
}
