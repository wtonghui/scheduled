import { createTransport } from "nodemailer";
import { config } from "@/lib/config";
import type { MailRequest, SendResult, MailService } from "./port";

/**
 * Pickup 适配器（dev/本地）：写入 MTA sendmail pickup 目录，不真实投递。
 */
export class PickupMailService implements MailService {
  private readonly transport = createTransport({
    sendmail: true,
    newline: "unix",
    path: "/usr/sbin/sendmail",
  });

  async verify(): Promise<void> {}

  async send(req: MailRequest): Promise<SendResult> {
    try {
      const info = await this.transport.sendMail({
        from: req.from ?? config.SMTP_FROM,
        to: req.to,
        subject: req.subject,
        html: req.html,
        text: req.text,
      });
      return { messageId: info.messageId ?? null, status: "sent" };
    } catch (error) {
      // 本地 sendmail 失败多为环境问题，透传原始 error 供 relay 分类（默认 permanent）
      return {
        messageId: null,
        providerResponse: (error as Error).message?.slice(0, 500),
        status: "failed",
        error,
      };
    }
  }
}