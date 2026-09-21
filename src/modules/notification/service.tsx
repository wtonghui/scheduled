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
  /** 失败专用标题模板；null=回退成功模板 */
  emailSubjectTemplateFailed?: string | null;
  /** 失败专用正文模板；null=回退成功模板 */
  emailBodyTemplateFailed?: string | null;
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

/** 邮件预览表格最多展示行数（完整结果走文件下载与站内查看）。 */
export const MAIL_PREVIEW_MAX_ROWS = 20;

/** HTML 转义（预览表格单元格用，防上游数据里的标签被执行）。 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** 字节数 → 人类可读（1887436 → 1.80 MB），解析失败回空串。 */
function formatFileSize(value: unknown): string {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) {
    return "";
  }
  if (n < 1024) {
    return `${n} B`;
  }
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return `${v.toFixed(2)} ${units[u]}`;
}

/**
 * JSON 字符串/数组二选一解析：
 * 上游 previewFileds/previewContent 是二次序列化的 JSON 字符串，
 * 兼容直接传数组的情况；解析失败返回 null（调用方降级）。
 */
function parseJsonArray(value: unknown): unknown[] | null {
  if (Array.isArray(value)) {
    return value;
  }
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 预览表格渲染：字段名做表头，前 N 行做表体，全程转义。
 * 任一步解析失败返回 null（调用方保留占位符原文 + warn，不炸邮件）。
 */
function buildPreviewTableHtml(
  fieldsValue: unknown,
  contentValue: unknown,
  maxRows: number,
): string | null {
  const fields = parseJsonArray(fieldsValue);
  const rows = parseJsonArray(contentValue);
  if (!fields || !rows) {
    return null;
  }
  const head = fields
    .map((f) => `<th>${escapeHtml(String(f))}</th>`)
    .join("");
  const body = rows
    .slice(0, maxRows)
    .map((row) => {
      const cells = fields
        .map((f) => {
          const v =
            row && typeof row === "object"
              ? (row as Record<string, unknown>)[String(f)]
              : null;
          return `<td>${escapeHtml(v == null ? "" : String(v))}</td>`;
        })
        .join("");
      return `<tr>${cells}</tr>`;
    })
    .join("");
  return `<table border="1" cellpadding="4" cellspacing="0"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
}

/**
 * 从执行器返回值中提取模板上下文。
 * HTTP 执行器返回 { status, redirects, attempt, data }，其中 data 是响应体 {code, msg, data}。
 * 上下文 = 内层 data 字段平铺（{rowCount}、{fileUrl}，老模板不受影响）
 * + 系统/派生字段（{statusText}、{failureReason}、{previewTableHtml}、{fileDesc}…）
 * + 中文别名（{任务名称}、{执行状态}、{失败原因}…）。
 * 失败路径执行器结果缺席时，用 summary.taskName/errorMessage 兜底，保证失败模板永远有字。
 */
function buildTemplateContext(summary: RunSummary): Record<string, unknown> {
  const envelope = (summary.result as { data?: unknown } | null | undefined)?.data;
  const inner =
    envelope && typeof envelope === "object" && !Array.isArray(envelope)
      ? (envelope as Record<string, unknown>).data
      : undefined;
  const data: Record<string, unknown> =
    inner && typeof inner === "object" && !Array.isArray(inner)
      ? { ...(inner as Record<string, unknown>) }
      : {};
  const ok = summary.status === "succeeded";
  const statusText = ok ? "成功" : "失败";

  // 失败原因：外层 msg 优先（业务失败），其次内层 failureReason，最后执行错误
  const envelopeMsg =
    envelope && typeof envelope === "object" && !Array.isArray(envelope)
      ? (envelope as Record<string, unknown>).msg
      : undefined;
  const failureReason =
    (!ok && typeof envelopeMsg === "string" && envelopeMsg.trim()
      ? envelopeMsg
      : null) ??
    (typeof data.failureReason === "string" && data.failureReason.trim()
      ? data.failureReason
      : null) ??
    summary.errorMessage ??
    "";

  // 预览表格：上游双 JSON 字符串在 worker 侧拼成 HTML，只取前 N 行
  const previewTableHtml = buildPreviewTableHtml(
    data.previewFileds ?? data.previewFields,
    data.previewContent,
    MAIL_PREVIEW_MAX_ROWS,
  );
  const previewTotal =
    typeof data.previewRowCount === "number" ? data.previewRowCount : null;
  const previewRowsMail =
    previewTotal != null ? Math.min(previewTotal, MAIL_PREVIEW_MAX_ROWS) : null;
  const rowTotal = typeof data.rowCount === "number" ? data.rowCount : null;
  const previewNote =
    rowTotal != null && previewTotal != null && previewRowsMail != null
      ? `预览共 ${previewTotal} 行，结果共 ${rowTotal} 行，本邮件展示前 ${previewRowsMail} 行，完整结果请下载文件或前往站内查看`
      : null;

  // 文件说明：文件名 + 人类可读大小 + 格式，缺啥略啥
  const fileSizeText = formatFileSize(data.fileSize);
  const fileDescParts = [
    typeof data.fileName === "string" && data.fileName ? data.fileName : null,
    typeof data.fileType === "string" && data.fileType ? data.fileType : null,
    fileSizeText || null,
  ].filter((p): p is string => p != null);
  const fileDesc = fileDescParts.length > 0 ? fileDescParts.join(" / ") : null;

  const taskName =
    typeof data.taskName === "string" && data.taskName ? data.taskName : summary.taskName;

  return {
    ...data,
    taskName,
    statusText,
    executionAt: data.executionAt ?? null,
    failureReason,
    rowCount: data.rowCount ?? null,
    fileType: data.fileType ?? null,
    fileUrl: data.fileUrl ?? null,
    viewUrl: data.viewUrl ?? null,
    previewTableHtml,
    previewRowsMail,
    previewNote,
    fileSizeText: fileSizeText || null,
    fileDesc,
    // 中文别名（信纸用中文占位同样可替换）
    任务名称: taskName,
    执行状态: statusText,
    执行时间: data.executionAt ?? null,
    失败原因: failureReason,
    结果总数量: data.rowCount ?? null,
    文件格式: data.fileType ?? null,
    预览行数: previewRowsMail,
    预览结果表格: previewTableHtml,
    文件说明: fileDesc,
    文件链接: data.fileUrl ?? null,
    站内链接: data.viewUrl ?? null,
  };
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
    /** 失败专用标题；null=回退 subject */
    subjectFailed?: string | null;
    /** 失败专用正文；null=回退 body */
    bodyFailed?: string | null;
    attachmentUrl?: string | null;
  },
): Promise<RenderedEmail> {
  const ctx = buildTemplateContext(summary);
  const logTag = { taskId: summary.taskId, runId: summary.executionId };
  const failed = summary.status !== "succeeded";

  // 标题/正文：失败优先用失败专用模板（null=回退成功模板，无模板用默认）
  const subjectTemplate = failed ? (templates?.subjectFailed ?? templates?.subject) : templates?.subject;
  const subject = subjectTemplate
    ? renderTemplate(subjectTemplate, ctx, logTag)
    : emailSubject(summary.taskName, summary.status);

  const bodyTemplate = failed ? (templates?.bodyFailed ?? templates?.body) : templates?.body;
  let html: string;
  let text: string;
  if (bodyTemplate) {
    html = renderTemplate(bodyTemplate, ctx, logTag);
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
        subjectFailed: ctx.emailSubjectTemplateFailed,
        bodyFailed: ctx.emailBodyTemplateFailed,
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
        emailSubjectTemplateFailed: true,
        emailBodyTemplateFailed: true,
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
      emailSubjectTemplateFailed: task.emailSubjectTemplateFailed,
      emailBodyTemplateFailed: task.emailBodyTemplateFailed,
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
