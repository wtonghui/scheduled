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
  /** 下次触发快照（终态写入前任务行的值；null=无后续运行） */
  nextRunAt?: Date | null;
  /** 停用原因快照（未停用=null） */
  disabledReason?: string | null;
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

/**
 * 终态通知意图快照：终态时刻冻结“这次该不该发 + 用什么发的”，与任务现状解耦。
 * 期望列当审计（事后改配置不影响旧 run 的记录）；渲染失败走降级兜底，无自动补单。
 * 不含密钥明文（webhook V3 固定密钥，中继时读 env）。
 */
export interface NotifySnapshot {
  tenantId: string;
  taskName: string;
  recipients: string[];
  notifyOn: string[];
  webhookUrl: string | null;
  systemUserId?: string | null;
  emailSubjectTemplate?: string | null;
  emailBodyTemplate?: string | null;
  emailSubjectTemplateFailed?: string | null;
  emailBodyTemplateFailed?: string | null;
  emailAttachmentUrlTemplate?: string | null;
  /** ISO 字符串；null=无后续运行 */
  nextRunAt?: string | null;
  disabledReason?: string | null;
  /** 执行器原始结果（模板渲染 + succeeded_with_results 已在终态判过，这里只为渲染） */
  result?: unknown;
}

/** 终态时刻判定期望（与 prepareNotificationOutbox 门控同口径，渲染成败不影响期望）。 */
export function notificationExpectation(
  ctx: Pick<NotifyContext, "recipients" | "notifyOn" | "webhookUrl">,
  statusKey: "succeeded" | "failed",
  result?: unknown,
): { emailExpected: boolean; webhookExpected: boolean } {
  return {
    emailExpected:
      ctx.recipients.length > 0 && shouldNotifyForStatus(ctx.notifyOn, statusKey, result),
    webhookExpected: !!ctx.webhookUrl?.trim(),
  };
}

/** 从终态上下文组装快照（含结果与下次触发，Date 转 ISO）。 */
export function buildNotifySnapshot(ctx: NotifyContext, summary: RunSummary): NotifySnapshot {
  return {
    tenantId: ctx.tenantId,
    taskName: ctx.taskName,
    recipients: ctx.recipients,
    notifyOn: ctx.notifyOn,
    webhookUrl: ctx.webhookUrl,
    systemUserId: ctx.systemUserId ?? null,
    emailSubjectTemplate: ctx.emailSubjectTemplate ?? null,
    emailBodyTemplate: ctx.emailBodyTemplate ?? null,
    emailSubjectTemplateFailed: ctx.emailSubjectTemplateFailed ?? null,
    emailBodyTemplateFailed: ctx.emailBodyTemplateFailed ?? null,
    emailAttachmentUrlTemplate: ctx.emailAttachmentUrlTemplate ?? null,
    nextRunAt: ctx.nextRunAt ? ctx.nextRunAt.toISOString() : null,
    disabledReason: ctx.disabledReason ?? null,
    ...(summary.result !== undefined ? { result: summary.result } : {}),
  };
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
  return `<table border="1" cellpadding="6" cellspacing="0" style="border-collapse:collapse;font-size:14px;"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`;
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

/** 正则特殊字符转义（linkify 按原文匹配 URL 用）。 */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const LINK_BUTTON_STYLE =
  "display:inline-block;background-color:#2563eb;color:#ffffff;" +
  "text-decoration:none;padding:8px 20px;border-radius:6px;font-size:14px;";

/**
 * 裸 URL 链接化：把正文里以纯文本出现的 URL 换成按钮（已在 href="..." 或 <a>…</a> 内的跳过，
 * 用户手写的链接不动）。label 为按钮文案，URL 只进 href（转义后），正文更干净。
 */
function linkifyPlainUrl(html: string, url: string, label: string): string {
  const anchor = `<a href="${escapeHtmlAttr(url)}" style="${LINK_BUTTON_STYLE}">${label}</a>`;
  const pattern = new RegExp(escapeRegExp(url), "g");
  return html.replace(pattern, (match, offset: number, full: string) => {
    const before = full.slice(0, offset as number);
    // 前面有未闭合的 <a → 已在链接标签头或链接文本区，跳过
    if (before.lastIndexOf("<a") > before.lastIndexOf("</a>")) {
      return match;
    }
    return anchor;
  });
}

/**
 * 自定义模板后处理（只进 HTML 版，纯文本版保留裸 URL 与原始换行）：
 * 1. `{文件链接}` → 「下载附件」按钮；`{站内链接}` → 「查看详情」按钮；
 * 2. 模板里的换行保留为 `<br>`（HTML 邮件原本会吞掉换行，导致多字段挤成一段）。
 */
function beautifyCustomEmailHtml(html: string, ctx: Record<string, unknown>): string {
  let out = html.replace(/\r\n/g, "\n");
  const fileUrl = typeof ctx.fileUrl === "string" ? ctx.fileUrl : "";
  const viewUrl = typeof ctx.viewUrl === "string" ? ctx.viewUrl : "";
  if (fileUrl) {
    out = linkifyPlainUrl(out, fileUrl, "下载附件");
  }
  if (viewUrl && viewUrl !== fileUrl) {
    out = linkifyPlainUrl(out, viewUrl, "查看详情");
  }
  return out.replace(/\n/g, "<br>");
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
    text = stripHtml(html); // 纯文本版：原始换行 + 裸 URL，信息完整可拷贝
    html = beautifyCustomEmailHtml(html, ctx);
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

  // 有附件且正文没带 URL 时追一个按钮式下载块：网关吞附件后用户仍有入口；
  // 全内联样式（邮件客户端兼容），模板自带链接的不重复。默认模板（无 attachmentUrl）不受影响。
  if (attachmentUrl && !html.includes(attachmentUrl)) {
    html +=
      `<div style="margin:24px 0 8px;">附件下载：</div>` +
      `<div style="margin:0 0 8px;"><a href="${escapeHtmlAttr(attachmentUrl)}" ` +
      `style="display:inline-block;background-color:#2563eb;color:#ffffff;` +
      `text-decoration:none;padding:10px 24px;border-radius:6px;font-size:14px;">下载附件</a></div>`;
    text = `${text}\n\n附件下载：${attachmentUrl}`;
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
  // Webhook V3：只看 webhookUrl 有无（有即终态必发），与邮件/notifyOn 解耦
  const shouldWebhook = !!ctx.webhookUrl?.trim();
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
        nextRunAt: ctx.nextRunAt ? toBeijingIso(ctx.nextRunAt) : null,
        disabledReason: ctx.disabledReason ?? null,
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

