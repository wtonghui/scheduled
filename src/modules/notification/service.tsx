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
 * "有结果"判定：执行器返回了业务数据（HTTP 响应体非空）。
 * noop 的 {kind} 无 data → false；HTTP 2xx 空 body → data 为 ""（空串非 null，算有结果）。
 * 注意：与邮件模板上下文无关，门控只看"有没有业务数据"。
 */
export function hasNotificationResults(result: unknown): boolean {
  if (!result || typeof result !== "object") {
    return false;
  }
  return (result as Record<string, unknown>).data != null;
}

/**
 * 通知门控（邮件与 Webhook 同闸）：
 * failed（含 timeout/dead，上游已归一）→ 含 failed 即通知；
 * succeeded → 含 succeeded 即通知，否则含 succeeded_with_results 且有业务数据才通知。
 * succeeded 与 succeeded_with_results 共存时前者为准（超集）。
 */
export function shouldNotifyForStatus(
  notifyOn: string[],
  statusKey: "succeeded" | "failed",
  result?: unknown,
): boolean {
  if (statusKey === "failed") {
    return notifyOn.includes("failed");
  }
  if (notifyOn.includes("succeeded")) {
    return true;
  }
  return notifyOn.includes("succeeded_with_results") && hasNotificationResults(result);
}

/**
 * 从执行器返回值中提取模板上下文。
 * HTTP 执行器返回 { status, redirects, attempt, data }，其中 data 是响应体 {code, msg, data}。
 * 直接用响应体里内层 data 对象的字段做上下文（{rowCount}、{fileUrl}）：
 * 有内层 data 且为对象 → 用它（原对象引用，不拷贝不合并）；
 * 否则 → 空上下文（占位符保留原文 + warn）。
 */
function buildTemplateContext(summary: RunSummary): Record<string, unknown> {
  const inner = (summary.result as { data?: { data?: unknown } } | null | undefined)?.data?.data;
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

/** href 属性转义（附件 URL 进正文兜底链接用）。 */
function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

  // 有附件且正文没带 URL 时追一段下载链接：网关吞附件后用户仍有入口；
  // 模板自带链接的不重复。默认模板（无 attachmentUrl）不受影响。
  if (attachmentUrl && !html.includes(attachmentUrl)) {
    html += `<p>附件下载：<a href="${escapeHtmlAttr(attachmentUrl)}">下载附件</a></p>`;
    text = `${text}\n附件下载：${attachmentUrl}`;
  }

  return { html, text, subject, attachmentUrl: attachmentUrl || null };
}

/** 事务外预渲染结果：CPU 活（React Email render），不在 DB 事务内持有连接。 */
export interface PreparedOutbox {
  email?: { toAddress: string; subject: string; html: string; text: string; attachmentUrl: string | null };
  webhook?: { url: string; payload: Prisma.InputJsonValue };
}

/** 门控+渲染（事务外调用）。渲染抛错由调用方按永久错处理（记日志不阻塞终态）。 */
export async function prepareNotificationOutbox(
  ctx: NotifyContext,
  summary: RunSummary,
): Promise<PreparedOutbox | null> {
  const statusKey = summary.status === "succeeded" ? "succeeded" : "failed";
  const shouldEmail =
    ctx.recipients.length > 0 && shouldNotifyForStatus(ctx.notifyOn, statusKey, summary.result);
  const shouldWebhook =
    !!ctx.webhookUrl && shouldNotifyForStatus(ctx.notifyOn, statusKey, summary.result);
  if (!shouldEmail && !shouldWebhook) {
    return null;
  }
  const out: PreparedOutbox = {};
  if (shouldEmail) {
    // 自定义模板坏了降级不断联：回退默认模板，保证至少能收到一封基础邮件
    try {
      const { html, text, subject, attachmentUrl } = await renderTaskEmail(summary, {
        subject: ctx.emailSubjectTemplate,
        body: ctx.emailBodyTemplate,
        attachmentUrl: ctx.emailAttachmentUrlTemplate,
      });
      out.email = {
        toAddress: JSON.stringify(ctx.recipients),
        subject,
        html,
        text,
        attachmentUrl,
      };
    } catch (error) {
      logger.error(
        { err: (error as Error).message, runId: summary.executionId },
        "custom email template failed, falling back to default",
      );
      const { html, text, subject, attachmentUrl } = await renderTaskEmail(summary, {});
      out.email = {
        toAddress: JSON.stringify(ctx.recipients),
        subject,
        html,
        text,
        attachmentUrl,
      };
    }
  }
  if (shouldWebhook && ctx.webhookUrl) {
    out.webhook = {
      url: ctx.webhookUrl,
      payload: buildWebhookPayload({
        runId: summary.executionId,
        taskId: ctx.taskId,
        taskName: ctx.taskName,
        status: summary.status,
        scheduledAt: toBeijingIso(summary.scheduledAt),
        startedAt: summary.startedAt ? toBeijingIso(summary.startedAt) : null,
        finishedAt: summary.finishedAt ? toBeijingIso(summary.finishedAt) : null,
        durationMs: summary.durationMs,
        ...(summary.errorMessage ? { error: { message: summary.errorMessage } } : {}),
      }) as Prisma.InputJsonValue,
    };
  }
  return out;
}

/** 预渲染结果入 outbox（事务内调用，只做 DB 写，无 CPU 渲染）。 */
export async function writePreparedOutbox(
  ctx: NotifyContext,
  summary: RunSummary,
  prepared: PreparedOutbox | null,
  client: Prisma.TransactionClient,
): Promise<void> {
  if (!prepared) {
    return;
  }
  if (prepared.email) {
    await client.emailLog.create({
      data: {
        runId: summary.executionId,
        taskId: ctx.taskId,
        tenantId: ctx.tenantId,
        toAddress: prepared.email.toAddress,
        subject: prepared.email.subject,
        html: prepared.email.html,
        text: prepared.email.text,
        attachmentUrl: prepared.email.attachmentUrl,
        status: "pending",
        maxAttempts: 5,
        ...(ctx.systemUserId ? { systemUserId: ctx.systemUserId } : {}),
      },
    });
  }
  if (prepared.webhook) {
    await client.webhookDelivery.create({
      data: {
        runId: summary.executionId,
        tenantId: ctx.tenantId,
        webhookUrl: prepared.webhook.url,
        payload: prepared.webhook.payload,
        webhookSecret: ctx.webhookSecretBytes ? new Uint8Array(ctx.webhookSecretBytes) : null,
        status: "pending",
        maxAttempts: 5,
        ...(ctx.systemUserId ? { systemUserId: ctx.systemUserId } : {}),
      },
    });
  }
}

/** 终态入 outbox（与执行终态同一事务写入则传 tx）。DB 写失败重抛回滚，防通知静默丢失；渲染失败只记日志不阻塞。 */
export async function enqueueNotificationsFromRun(
  ctx: NotifyContext,
  summary: RunSummary,
  tx?: Prisma.TransactionClient,
): Promise<void> {
  let prepared: PreparedOutbox | null;
  try {
    prepared = await prepareNotificationOutbox(ctx, summary);
  } catch (error) {
    logger.error(
      { err: (error as Error).message, runId: summary.executionId },
      "notification render failed, skipping outbox",
    );
    return;
  }
  if (!prepared) {
    return;
  }
  try {
    const client = tx ?? prisma;
    await writePreparedOutbox(ctx, summary, prepared, client as Prisma.TransactionClient);
  } catch (error) {
    if ((error as { code?: string }).code === "P2002") {
      // run_id 唯一：幂等命中，忽略
      return;
    }
    logger.error(
      { err: (error as Error).message, runId: summary.executionId },
      "enqueue notifications failed",
    );
    throw error;
  }
}

/** 自愈窗口：只补最近 7 天终态，避免给几个月前的历史补发骚扰。 */
const HEAL_WINDOW_MS = 7 * 24 * 3600 * 1000;
/** 单轮自愈上限：heal 是兜底慢通道，不跟正常中继抢池。 */
const HEAL_BATCH = 50;

/**
 * 历史坏账自愈（第2项吞错时代+极端渲染失败残留）：
 * 扫最近 7 天终态执行，缺 outbox 行 → 按 run_id 幂等补插。
 * `succeeded_with_results` 因缺执行结果上下文无法准确判定，跳过（宁漏勿错，发了多余通知更糟）。
 * @returns 补插的行数
 */
export async function healMissingOutbox(limit = HEAL_BATCH): Promise<number> {
  const since = new Date(Date.now() - HEAL_WINDOW_MS);
  const runs = await prisma.taskExecution.findMany({
    where: {
      status: { in: ["succeeded", "failed", "dead", "timeout"] },
      finishedAt: { gte: since },
    },
    orderBy: { finishedAt: "desc" },
    take: limit,
    select: {
      id: true,
      taskId: true,
      status: true,
      scheduledAt: true,
      startedAt: true,
      finishedAt: true,
      durationMs: true,
      error: true,
    },
  });
  let healed = 0;
  for (const run of runs) {
    const task = await prisma.task.findUnique({
      where: { id: run.taskId },
      select: {
        id: true,
        name: true,
        tenantId: true,
        recipients: true,
        notifyOn: true,
        webhookUrl: true,
        webhookSecret: true,
        systemUserId: true,
        emailSubjectTemplate: true,
        emailBodyTemplate: true,
        emailAttachmentUrlTemplate: true,
      },
    });
    if (!task) {
      continue;
    }
    const notifyOn = (task.notifyOn as string[]) ?? [];
    const plainOk =
      run.status === "succeeded" ? notifyOn.includes("succeeded") : notifyOn.includes("failed");
    if (!plainOk) {
      continue;
    }
    const recipients = (task.recipients as string[]) ?? [];
    const needEmail = recipients.length > 0;
    const needWebhook = !!task.webhookUrl;
    if (!needEmail && !needWebhook) {
      continue;
    }
    const [hasEmail, hasWebhook] = await Promise.all([
      needEmail
        ? prisma.emailLog.findUnique({ where: { runId: run.id }, select: { id: true } })
        : Promise.resolve(true),
      needWebhook
        ? prisma.webhookDelivery.findUnique({ where: { runId: run.id }, select: { id: true } })
        : Promise.resolve(true),
    ]);
    if (hasEmail && hasWebhook) {
      continue;
    }
    const errObj = run.error as { message?: unknown } | null;
    const ctx: NotifyContext = {
      tenantId: task.tenantId,
      taskId: task.id,
      taskName: task.name,
      recipients,
      notifyOn,
      webhookUrl: task.webhookUrl,
      webhookSecretBytes: task.webhookSecret ? new Uint8Array(task.webhookSecret) : null,
      systemUserId: task.systemUserId,
      emailSubjectTemplate: task.emailSubjectTemplate,
      emailBodyTemplate: task.emailBodyTemplate,
      emailAttachmentUrlTemplate: task.emailAttachmentUrlTemplate,
    };
    const summary: RunSummary = {
      executionId: run.id,
      taskId: task.id,
      taskName: task.name,
      status: run.status === "succeeded" ? "succeeded" : "failed",
      scheduledAt: run.scheduledAt,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      errorMessage: typeof errObj?.message === "string" ? errObj.message : null,
    };
    let prepared: PreparedOutbox | null;
    try {
      prepared = await prepareNotificationOutbox(ctx, summary);
    } catch (error) {
      logger.error(
        { err: (error as Error).message, runId: run.id },
        "heal render failed, skipping run",
      );
      continue;
    }
    if (!prepared) {
      continue;
    }
    try {
      if (needEmail && !hasEmail && prepared.email) {
        await prisma.emailLog.create({
          data: {
            runId: run.id,
            taskId: task.id,
            tenantId: task.tenantId,
            toAddress: prepared.email.toAddress,
            subject: prepared.email.subject,
            html: prepared.email.html,
            text: prepared.email.text,
            attachmentUrl: prepared.email.attachmentUrl,
            status: "pending",
            maxAttempts: 5,
            ...(task.systemUserId ? { systemUserId: task.systemUserId } : {}),
          },
        });
        healed += 1;
      }
      if (needWebhook && !hasWebhook && prepared.webhook) {
        await prisma.webhookDelivery.create({
          data: {
            runId: run.id,
            tenantId: task.tenantId,
            webhookUrl: prepared.webhook.url,
            payload: prepared.webhook.payload,
            webhookSecret: ctx.webhookSecretBytes
              ? new Uint8Array(ctx.webhookSecretBytes)
              : null,
            status: "pending",
            maxAttempts: 5,
            ...(task.systemUserId ? { systemUserId: task.systemUserId } : {}),
          },
        });
        healed += 1;
      }
    } catch (error) {
      if ((error as { code?: string }).code === "P2002") {
        continue;
      }
      logger.warn({ err: (error as Error).message, runId: run.id }, "heal backfill failed");
    }
  }
  return healed;
}
