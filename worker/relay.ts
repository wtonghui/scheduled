import { prisma } from "../src/lib/db";
import { getMailService, type MailAttachment } from "../src/mail/port";
import { classifyError, jitteredDelayMs } from "../src/lib/retry";
import { emailSentTotal, emailFailedTotal } from "../src/lib/metrics";
import { logger } from "../src/lib/logger";
import { checkUrlForSsrf } from "../src/lib/ssrf";

/** 附件下载大小上限（10MB）。 */
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

/**
 * 从 URL 下载附件（SSRF 检查 + 大小限制）。
 * 失败/超限 → 返回 null（邮件照发，无附件；URL 已在正文模板的 <a href> 里）。
 */
async function downloadAttachment(url: string): Promise<MailAttachment | null> {
  const ssrf = await checkUrlForSsrf(url);
  if (!ssrf.ok) {
    logger.warn({ url, reason: ssrf.reason }, "attachment url blocked by SSRF policy");
    return null;
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) {
      logger.warn({ url, status: res.status }, "attachment download failed");
      return null;
    }
    const contentLength = Number(res.headers.get("content-length") ?? 0);
    if (contentLength > MAX_ATTACHMENT_BYTES) {
      logger.warn({ url, contentLength }, "attachment too large, skipping");
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_ATTACHMENT_BYTES) {
      logger.warn({ url, size: buf.length }, "attachment too large (actual), skipping");
      return null;
    }
    const filename = url.split("/").pop()?.split("?")[0] || "attachment";
    const contentType = res.headers.get("content-type") ?? undefined;
    return { filename, content: buf, contentType };
  } catch (error) {
    logger.warn({ url, err: (error as Error).message }, "attachment download error");
    return null;
  }
}

/**
 * 邮件中继（US3 独立测试场景）：轮询 email_log(pending) → MailService.send → 状态机。
 * 幂等：run_id UNIQUE（enqueue 侧）+ in_progress 乐观认领（本侧）。
 * payload 已持久化 html/text，不依赖任务行。
 * 认领后崩溃遗留的 in_progress（updatedAt 超过阈值）会被回收重投，避免静默丢失。
 */

/** in_progress 回收阈值：认领后 10 分钟仍未终态视为认领者已死（中继节拍秒级，正常投递远快于此）。 */
const STALE_IN_PROGRESS_MS = 10 * 60 * 1000;

export async function runEmailRelayOnce(limit = 20): Promise<number> {
  const now = new Date();
  const staleBefore = new Date(now.getTime() - STALE_IN_PROGRESS_MS);
  const rows = await prisma.emailLog.findMany({
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
    const claimed = await prisma.emailLog.updateMany({
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
      logger.warn({ run_id: row.runId }, "reclaimed stale in_progress email, redelivering");
    }

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
        throw new Error("mail provider reported failure");
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
      const base = { attempts, lastError: (error as Error).message };
      emailFailedTotal.inc();
      if (attempts >= row.maxAttempts) {
        await prisma.emailLog.update({
          where: { id: row.id },
          data: { ...base, status: "dead" },
        });
        logger.error({ run_id: row.runId, attempts }, "email dead-lettered");
      } else {
        const retryable = classifyError(error) === "retryable";
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
  }
  return delivered;
}
