import { config } from "@/lib/config";
import { toBeijingIso } from "@/lib/datetime";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { TaskCompleteEmail } from "@/mail/emails/TaskCompleteEmail";
import { buildWebhookPayload } from "@/modules/webhook/service";
import type { Prisma } from "@prisma/client";
import { render } from "@react-email/render";

/**
 * 终态通知（FR-008/FR-009/FR-016）：
 * 任务执行终态与 email_log / webhook_delivery(pending) 在同一事务写入（outbox），
 * run_id 唯一 = 幂等闸；由独立中继投递。重试运行绝不重复发送。
 */

export interface NotifyContext {
  tenantId: string;
  taskId: string;
  taskName: string;
  recipients: string[];
  notifyOn: string[];
  webhookUrl: string | null;
  /** AES 加密后的 HMAC 密钥快照（中继解密后验签；任务被删仍可投递）。 */
  webhookSecretBytes: Uint8Array | null;
}

export interface RunSummary {
  executionId: string;
  taskId: string;
  taskName: string;
  status: "succeeded" | "failed" | "dead";
  scheduledAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  durationMs: number | null;
  errorMessage?: string | null;
}

function emailSubject(taskName: string, status: string): string {
  const ok = status === "succeeded";
  return `${ok ? "✅" : "❌"} [${taskName}] 执行${ok ? "成功" : "失败"}`;
}

export async function renderTaskEmail(summary: RunSummary): Promise<{
  html: string;
  text: string;
  subject: string;
}> {
  const props = {
    taskName: summary.taskName,
    status: summary.status === "succeeded" ? ("succeeded" as const) : ("failed" as const),
    taskId: summary.taskId,
    runId: summary.executionId,
    scheduledAt: toBeijingIso(summary.scheduledAt),
    durationMs: summary.durationMs,
    errorMessage: summary.errorMessage ?? null,
    appBaseUrl: config.APP_BASE_URL,
  };
  const email = <TaskCompleteEmail {...props} />;
  return {
    html: await render(email),
    text: await render(email, { plainText: true }),
    subject: emailSubject(summary.taskName, summary.status),
  };
}

/** 终态入 outbox（与执行终态同一事务写入则传 tx）。失败不抛（避免影响执行结果）。 */
export async function enqueueNotificationsFromRun(
  ctx: NotifyContext,
  summary: RunSummary,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  try {
    const statusKey = summary.status === "succeeded" ? "succeeded" : "failed";
    const shouldEmail =
      ctx.recipients.length > 0 &&
      (ctx.notifyOn.includes("succeeded") || ctx.notifyOn.includes("failed")) &&
      ctx.notifyOn.includes(statusKey);
    const shouldWebhook = !!ctx.webhookUrl;

    if (!shouldEmail && !shouldWebhook) {
      return;
    }

    const client = tx ?? prisma;
    if (shouldEmail) {
      const { html, text, subject } = await renderTaskEmail(summary);
      await client.emailLog.create({
        data: {
          runId: summary.executionId,
          taskId: ctx.taskId,
          tenantId: ctx.tenantId,
          toAddress: JSON.stringify(ctx.recipients),
          subject,
          html,
          text,
          status: "pending",
          maxAttempts: 5,
        },
      });
    }
    if (shouldWebhook && ctx.webhookUrl) {
      const payload = buildWebhookPayload({
        runId: summary.executionId,
        taskId: ctx.taskId,
        taskName: ctx.taskName,
        status: summary.status,
        scheduledAt: toBeijingIso(summary.scheduledAt),
        startedAt: summary.startedAt ? toBeijingIso(summary.startedAt) : null,
        finishedAt: summary.finishedAt ? toBeijingIso(summary.finishedAt) : null,
        durationMs: summary.durationMs,
        ...(summary.errorMessage ? { error: { message: summary.errorMessage } } : {}),
      });
      await client.webhookDelivery.create({
        data: {
          runId: summary.executionId,
          tenantId: ctx.tenantId,
          webhookUrl: ctx.webhookUrl,
          payload,
          webhookSecret: ctx.webhookSecretBytes ? new Uint8Array(ctx.webhookSecretBytes) : null,
          status: "pending",
          maxAttempts: 5,
        },
      });
    }
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      // run_id 唯一：幂等命中，忽略
      return;
    }
    logger.error(
      { err: (error as Error).message, runId: summary.executionId },
      "enqueue notifications failed",
    );
  }
}
