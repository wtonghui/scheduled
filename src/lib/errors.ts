/**
 * 共享错误类型：API 信封、worker、lib 统一使用。
 * - AppError：HTTP 语义错误，由 API 中间件转为统一信封。
 * - TimeoutError：执行超时（withTimeout / retry 分类）。
 * - HttpError：HTTP 任务结果错误，带上游状态码（用于重试分类）。
 */

export class AppError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** 单次执行超时（可重试错误类）。 */
export class TimeoutError extends Error {
  constructor(message = "operation timed out") {
    super(message);
    this.name = "TimeoutError";
  }
}

/** HTTP 任务结果错误：`status` 为上游响应状态码（429/5xx 可重试，4xx 永久失败）。 */
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}