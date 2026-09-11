import pino from "pino";
import { config } from "./config";

/**
 * pino 单例：结构化 JSON → stdout。
 * 约法 §IV：每个生命周期事件产出结构化日志。
 */
export const logger = pino({
  level: config.LOG_LEVEL,
  base: { service: "scheduled" },
  redact: {
    // 明文绝不入日志（约法：token/payload 明文敏感）
    paths: [
      "token",
      "tokenHash",
      "Authorization",
      "x-api-token",
      "payload.headers.authorization",
      "payload.body",
      "webhookSecret",
      "execSignSecret",
      "TASK_CALLBACK_SIGN_SECRET",
      "PAYLOAD_ENCRYPTION_KEY",
      "SMTP_PASS",
    ],
    censor: "[REDACTED]",
  },
  transport:
    config.NODE_ENV === "development"
      ? { target: "pino-pretty", options: { colorize: true } }
      : undefined,
});

/** 创建带任务上下文的 child logger */
export function taskLogger(taskId: string, extra?: Record<string, unknown>) {
  return logger.child({ task_id: taskId, ...extra });
}
