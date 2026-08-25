import { config } from "@/lib/config";
import { logger } from "@/lib/logger";
import type { MailRequest, SendResult, MailService } from "./port";

/**
 * HTTP 邮件服务适配器（对接自有 HTTP 邮件服务，可选）。
 * POST MAIL_HTTP_URL，Authorization: Bearer MAIL_HTTP_TOKEN，body 含 idempotency_key。
 */
export class HttpMailService implements MailService {
  async verify(): Promise<void> {
    if (!config.MAIL_HTTP_URL) {
      throw new Error("MAIL_HTTP_URL is required for provider=http");
    }
  }

  async send(req: MailRequest): Promise<SendResult> {
    if (!config.MAIL_HTTP_URL) {
      return { messageId: null, status: "failed" };
    }
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), config.MAIL_HTTP_TIMEOUT_MS);
      const res = await fetch(config.MAIL_HTTP_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.MAIL_HTTP_TOKEN
            ? { authorization: `Bearer ${config.MAIL_HTTP_TOKEN}` }
            : {}),
        },
        body: JSON.stringify({
          from: req.from,
          to: req.to,
          cc: req.cc,
          bcc: req.bcc,
          subject: req.subject,
          html: req.html,
          text: req.text,
          headers: req.headers,
          idempotency_key: req.externalRef,
        }),
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) {
        throw new Error(`http mail provider responded ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as { messageId?: string };
      return { messageId: body.messageId ?? null, status: "sent" };
    } catch (error) {
      logger.error({ err: (error as Error).message }, "http mail send failed");
      return { messageId: null, status: "failed" };
    }
  }
}