import { logger } from "@/lib/logger";
import { HttpMailService } from "./http-mail.service";
import { PickupMailService } from "./pickup-mail.service";
import { SmtpMailService } from "./smtp-mail.service";

/**
 * MailService 端口（六边形 driven，contracts/mail-provider.md）。
 * 适配器：smtp/http/pickup/json 由 MAIL_PROVIDER 选择（v1 默认 json，Phase 5 补充适配器）。
 */

export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailRequest {
  to: string[];
  cc?: string[];
  bcc?: string[];
  replyTo?: string;
  subject: string;
  html: string;
  text: string;
  from?: string;
  headers?: Record<string, string>;
  /** = run_id（幂等键表面） */
  externalRef?: string;
  /** 附件（relay 从 attachment_url 下载后填入；SMTP 适配器透传给 nodemailer） */
  attachments?: MailAttachment[];
}

export interface SendResult {
  messageId: string | null;
  providerResponse?: string;
  status: "sent" | "failed";
  /**
   * 原始错误透传（P0-1）：适配器 catch 后不再吞错，relay 用它做重试分类。
   * 成功时为 undefined；失败时为抛出的原始 Error（含 code/responseCode）。
   */
  error?: unknown;
}

export interface MailService {
  send(req: MailRequest): Promise<SendResult>;
  /** 启动探活，失败抛错 */
  verify(): Promise<void>;
}

/** dev 用：仅记录，不真实投递。 */
export class JsonMailService implements MailService {
  async send(req: MailRequest): Promise<SendResult> {
    logger.info({ msg: "mail.send(json)", to: req.to, subject: req.subject, ref: req.externalRef });
    return { messageId: `json-${Date.now()}`, providerResponse: "json provider", status: "sent" };
  }

  async verify(): Promise<void> {
    logger.trace("mail.verify(json)");
  }
}

let instance: MailService | null = null;

/** 按 MAIL_PROVIDER 构造 MailService 单例（json 为 v1 默认；smtp/http/pickup 在 Phase 5 接入）。 */
export function getMailService(): MailService {
  if (instance) {
    return instance;
  }
  const provider = process.env.MAIL_PROVIDER ?? "json";
  switch (provider) {
    case "smtp":
      instance = new SmtpMailService();
      break;
    case "http":
      instance = new HttpMailService();
      break;
    case "pickup":
      instance = new PickupMailService();
      break;
    default:
      instance = new JsonMailService();
  }
  return instance;
}
