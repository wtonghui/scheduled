import { config } from "@/lib/config";
import { HttpError, TimeoutError } from "@/lib/errors";
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
      const error = new Error("MAIL_HTTP_URL is required for provider=http");
      return { messageId: null, status: "failed", error };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.MAIL_HTTP_TIMEOUT_MS);
    try {
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
        // 带状态码的 HttpError：relay 据 429/5xx 重试、4xx 进死信（此前 message 字符串分类器看不到）
        throw new HttpError(res.status, `http mail provider responded ${res.status}`);
      }
      const body = (await res.json().catch(() => ({}))) as { messageId?: string };
      return { messageId: body.messageId ?? null, status: "sent" };
    } catch (error) {
      clearTimeout(timer);
      const name = (error as { name?: string }).name ?? "";
      const normalized =
        error instanceof HttpError
          ? error
          : name === "TimeoutError" || name === "AbortError"
            ? new TimeoutError(`http mail timed out after ${config.MAIL_HTTP_TIMEOUT_MS}ms`)
            : error;
      logger.error({ err: (error as Error).message }, "http mail send failed");
      return {
        messageId: null,
        providerResponse: (error as Error).message?.slice(0, 500),
        status: "failed",
        error: normalized,
      };
    }
  }
}