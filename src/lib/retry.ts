import { TimeoutError, HttpError } from "./errors";

/**
 * 全抖动指数退避 + 错误分类（research.md §4）。
 * delay = uniform(0, min(capMs, baseMs * factor^attempt))，attempt 从 0 起。
 */

export type RetryVerdict = "retryable" | "permanent";

/** 网络瞬时错误码（Node/undici/nodemailer）→ 可重试。ECONNECTION/ESOCKET 为 nodemailer 连接层错误。 */
const RETRYABLE_NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "ECONNABORTED",
  "ECONNECTION",
  "ESOCKET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "EADDRNOTAVAIL",
  "EAI_AGAIN",
  "ENOTFOUND",
  "EPIPE",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
]);

/**
 * 错误分类：决定是否重试。
 * - 可重试：网络瞬时、超时、429/5xx、SMTP 4xx（421/451/452）、DB 死锁/锁等待（P2034）。
 * - 永久：4xx（除 429）、SMTP 5xx（550 等）、Zod 校验、程序 bug。
 */
export function classifyError(error: unknown): RetryVerdict {
  if (error instanceof TimeoutError) {
    return "retryable";
  }

  const err = error as {
    code?: unknown;
    status?: unknown;
    responseCode?: unknown;
    name?: string;
  } | null;

  if (err && typeof err.code === "string" && RETRYABLE_NETWORK_CODES.has(err.code)) {
    return "retryable";
  }

  // SMTP 响应码（nodemailer responseCode）：4xx=瞬断（421/451/452 灰名单/限流）可重试，5xx=永久。
  // 优先级高于 code：EENVELOPE+421 应重试，EENVELOPE+550 应死信。
  if (err && typeof err.responseCode === "number") {
    if (err.responseCode >= 400 && err.responseCode < 500) {
      return "retryable";
    }
    if (err.responseCode >= 500) {
      return "permanent";
    }
  }

  // Prisma 事务冲突 / 写冲突 → 可重试
  if (err && err.code === "P2034") {
    return "retryable";
  }

  if (error instanceof HttpError) {
    if (error.status >= 500 || error.status === 429) {
      return "retryable";
    }
    return "permanent";
  }

  // 上游透传的 HTTP 状态
  if (err && typeof err.status === "number") {
    const status = err.status;
    if (status >= 500 || status === 429) {
      return "retryable";
    }
    if (status >= 400 && status < 500) {
      return "permanent";
    }
  }

  // 程序 bug / 校验错误 → 永久
  const name = err?.name;
  if (
    name === "ZodError" ||
    name === "TypeError" ||
    name === "ReferenceError" ||
    name === "RangeError" ||
    name === "SyntaxError"
  ) {
    return "permanent";
  }

  return "permanent";
}

export interface RetryOptions<T> {
  attempts: number;
  fn: (attempt: number) => Promise<T>;
  baseMs?: number;
  factor?: number;
  capMs?: number;
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
}

/** 全抖动延迟：uniform(0, min(cap, base*factor^attempt))。 */
export function jitteredDelayMs(
  baseMs: number,
  factor: number,
  capMs: number,
  attemptIndex: number,
): number {
  const max = Math.min(capMs, baseMs * factor ** attemptIndex);
  return Math.random() * max;
}

/**
 * 任务重试等待：基线可配，封顶取 30s 与基线较大者。
 * 默认 base=1000 时恒为 30s 封顶（老行为不变）；自定义基线（如 300000）不再被 30s 钳住。
 * attemptIndex 从 0 起（第 1 次失败后等待传 0）。
 */
export function computeRetryDelayMs(baseMs: number, attemptIndex: number): number {
  return jitteredDelayMs(baseMs, 2, Math.max(30000, baseMs), attemptIndex);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function retryWithJitter<T>(options: RetryOptions<T>): Promise<T> {
  const {
    attempts,
    fn,
    baseMs = 1000,
    factor = 2,
    capMs = 30000,
    shouldRetry = (error) => classifyError(error) === "retryable",
  } = options;

  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      if (attempt >= attempts) {
        break;
      }
      if (!shouldRetry(error, attempt)) {
        throw error;
      }
      const delayMs = jitteredDelayMs(baseMs, factor, capMs, attempt - 1);
      options.onRetry?.(error, attempt, delayMs);
      await sleep(delayMs);
    }
  }

  throw lastError;
}
