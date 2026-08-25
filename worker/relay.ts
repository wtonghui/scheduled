import { prisma } from "../src/lib/db";
import { getMailService } from "../src/mail/port";
import { classifyError, jitteredDelayMs } from "../src/lib/retry";
import { emailSentTotal, emailFailedTotal } from "../src/lib/metrics";
import { logger } from "../src/lib/logger";

/**
 * 邮件中继（US3 独立测试场景）：轮询 email_log(pending) → MailService.send → 状态机。
 * 幂等：run_id UNIQUE（enqueue 侧）+ in_progress 乐观认领（本侧）。
 * payload 已持久化 html/text，不依赖任务行。
 */

export async function runEmailRelayOnce(limit = 20): Promise<number> {
  const now = new Date();
  const rows = await prisma.emailLog.findMany({
    where: {
      status: { in: ["pending"] },
      OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: now } }],
    },
    orderBy: { id: "asc" },
    take: limit,
  });

  let delivered = 0;
  for (const row of rows) {
    const claimed = await prisma.emailLog.updateMany({
      where: { id: row.id, status: "pending" },
      data: { status: "in_progress" },
    });
    if (claimed.count === 0) {
      continue;
    }

    try {
      const to = JSON.parse(row.toAddress) as string[];
      const result = await getMailService().send({
        to,
        subject: row.subject,
        html: row.html ?? "",
        text: row.text ?? "",
        externalRef: row.runId,
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