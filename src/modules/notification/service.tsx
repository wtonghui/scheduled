import { config } from "@/lib/config";
import { toBeijingIso } from "@/lib/datetime";
import { prisma } from "@/lib/db";
import { logger } from "@/lib/logger";
import { renderTemplate } from "@/lib/template";
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
  /** 系统内用户标识（外部接入系统具体用户），用于通知归属追溯。 */
  systemUserId?: string | null;
  /** 邮件标题模板；null=默认标题 */
  emailSubjectTemplate?: string | null;
  /** 邮件正文模板（HTML）；null=默认 React Email */
  emailBodyTemplate?: string | null;
  /** 附件 URL 模板；null=无附件 */
  emailAttachmentUrlTemplate?: string | null;
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
  /** 执行器返回结果（HTTP 响应体等），用于邮件模板占位符替换；失败时为 null */
  result?: unknown;
}

function emailSubject(taskName: string, status: string): string {
  const ok = status === "succeeded";
  return `${ok ? "✅" : "❌"} [${taskName}] 执行${ok ? "成功" : "失败"}`;
}

/**
 * 从执行器返回值中提取模板上下文。
 * HTTP 执行器返回 { status, redirects, attempt, data }，其中 data 是响应体 {code, msg, data}。
 * 直接用响应体里内层 data 对象的字段做上下文（{rowCount}、{fileUrl}）：
 * 有内层 data 且为对象 → 用它（原对象引用，不拷贝不合并）；
 * 否则 → 空上下文（占位符保留原文 + warn）。
 */
function buildTemplateContext(summary: RunSummary): Record<string, unknown> {
  const inner = (summary.result as { data?: { data?: unknown } } | null | undefined)?.data
    ?.data;
  if (inner && typeof inner === "object" && !Array.isArray(inner)) {
    return inner as Record<string, unknown>;
  }
  return {};
}

/** 简易 HTML → 纯文本：剥标签、压缩空白。给纯文本邮件客户端兜底用。 */
function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export interface RenderedEmail {
  html: string;
  text: string;
  subject: string;
  attachmentUrl: string | null;
}

export async function renderTaskEmail(
  summary: RunSummary,
  templates?: {
    subject?: string | null;
    body?: string | null;
    attachmentUrl?: string | null;
  },
): Promise<RenderedEmail> {
  const ctx = buildTemplateContext(summary);
  const logTag = { taskId: summary.taskId, runId: summary.executionId };

  // 标题：有模板用模板，无模板用默认
  const subject = templates?.subject
    ? renderTemplate(templates.subject, ctx, logTag)
    : emailSubject(summary.taskName, summary.status);

  // 正文：有模板用模板（HTML），无模板用默认 React Email
  let html: string;
  let text: string;
  if (templates?.body) {
    html = renderTemplate(templates.body, ctx, logTag);
    text = stripHtml(html);
  } else {
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
    html = await render(email);
    text = await render(email, { plainText: true });
  }

  // 附件 URL：有模板才渲染，无模板 null
  const attachmentUrl = templates?.attachmentUrl
    ? renderTemplate(templates.attachmentUrl, ctx, logTag)
    : null;

  return { html, text, subject, attachmentUrl: attachmentUrl || null };
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
    // webhook 与邮件同受 notifyOn 约束（timeout/dead 按 failed 归类）
    const shouldWebhook = !!ctx.webhookUrl && ctx.notifyOn.includes(statusKey);

    if (!shouldEmail && !shouldWebhook) {
      return;
    }

    const client = tx ?? prisma;
    if (shouldEmail) {
      const { html, text, subject, attachmentUrl } = await renderTaskEmail(summary, {
        subject: ctx.emailSubjectTemplate,
        body: ctx.emailBodyTemplate,
        attachmentUrl: ctx.emailAttachmentUrlTemplate,
      });
      await client.emailLog.create({
        data: {
          runId: summary.executionId,
          taskId: ctx.taskId,
          tenantId: ctx.tenantId,
          toAddress: JSON.stringify(ctx.recipients),
          subject,
          html,
          text,
          attachmentUrl,
          status: "pending",
          maxAttempts: 5,
          ...(ctx.systemUserId ? { systemUserId: ctx.systemUserId } : {}),
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
          ...(ctx.systemUserId ? { systemUserId: ctx.systemUserId } : {}),
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
