import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import nodemailer, { type Transporter } from "nodemailer";
import type { MailRequest, MailService, SendResult } from "./port";

/**
 * SMTP 适配器（contracts/mail-provider.md，nodemailer 9）。
 * pooled transport；starttls 587 / 465 secure；幂等 via Message-ID / externalRef。
 */
export class SmtpMailService implements MailService {
  private readonly transporter: Transporter;

  constructor() {
    this.transporter = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      // TLS 直连：SMTP_SECURE 显式指定时优先；否则按端口推断（465=true，587 等=false）
      secure: config.SMTP_SECURE ?? config.SMTP_PORT === 465,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASS ?? "" } : undefined,
      pool: true,
      maxConnections: config.SMTP_MAX_CONNECTIONS,
      rateLimit: config.SMTP_RATE_LIMIT,
      connectionTimeout: config.SMTP_TIMEOUT_MS,
      greetingTimeout: config.SMTP_TIMEOUT_MS,
      socketTimeout: config.SMTP_TIMEOUT_MS,
      tls: {
        minVersion: "TLSv1.2",
        // 证书信任 *（SMTP_TLS_REJECT_UNAUTHORIZED=false 时关闭证书校验）
        ...(config.SMTP_TLS_REJECT_UNAUTHORIZED === false ? { rejectUnauthorized: false } : {}),
      },
    });
  }

  async verify(): Promise<void> {
    await this.transporter.verify();
  }

  async send(req: MailRequest): Promise<SendResult> {
    try {
      const info = await this.transporter.sendMail({
        from: req.from ?? config.SMTP_FROM,
        to: req.to,
        cc: req.cc,
        bcc: req.bcc,
        replyTo: req.replyTo,
        subject: req.subject,
        html: req.html,
        text: req.text,
        headers: {
          ...(req.externalRef ? { "X-Scheduled-Run-Id": req.externalRef } : {}),
          ...req.headers,
        },
        ...(req.attachments && req.attachments.length > 0
          ? {
              attachments: req.attachments.map((a) => ({
                filename: a.filename,
                content: a.content,
                contentType: a.contentType,
              })),
            }
          : {}),
      });
      return { messageId: info.messageId ?? null, providerResponse: info.response, status: "sent" };
    } catch (error) {
      const err = error as { code?: unknown; responseCode?: unknown; message?: string };
      const code = typeof err?.code === "string" ? err.code : undefined;
      const responseCode = typeof err?.responseCode === "number" ? err.responseCode : undefined;
      const detail = [
        err?.message ?? String(error),
        code ? `code=${code}` : null,
        responseCode !== undefined ? `responseCode=${responseCode}` : null,
      ]
        .filter(Boolean)
        .join(" ")
        .slice(0, 500);
      logger.error({ err: (error as Error).message, code, responseCode }, "smtp send failed");
      // 透传原始 error：relay 据 code/responseCode 判可重试（421/连接瞬断）还是永久（550）
      return { messageId: null, providerResponse: detail, status: "failed", error };
    }
  }
}
