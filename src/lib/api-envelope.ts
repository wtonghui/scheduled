import { NextResponse } from "next/server";
import { serializeDates } from "./datetime";
import { AppError } from "./errors";

/**
 * API 统一信封（contracts/api.md）：`{ success, data?, error?, meta? }`。
 * 错误映射：AppError → 对应状态码；未知错误 → 500 且不泄露内部细节。
 */

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown[];
}

export interface ApiEnvelope<T> {
  success: boolean;
  data?: T;
  error?: ApiErrorBody;
  meta?: { page: number; pageSize: number; total: number };
}

export function ok<T>(data?: T, meta?: ApiEnvelope<T>["meta"], status = 200): NextResponse {
  // 出口统一把 Date 序列化为北京时间（+08:00 偏移）ISO 字符串，见 ./datetime.ts。
  const body: ApiEnvelope<unknown> = {
    success: true,
    data: data === undefined ? undefined : serializeDates(data),
    meta,
  };
  return NextResponse.json(body, { status });
}

export function okCreated<T>(data: T): NextResponse {
  return ok(data, undefined, 201);
}

export function noContent(): NextResponse {
  return new NextResponse(null, { status: 204 });
}

export function fail(error: unknown): NextResponse {
  if (error instanceof AppError) {
    return NextResponse.json(
      {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          details: error.details
            ? Array.isArray(error.details)
              ? error.details
              : [error.details]
            : undefined,
        },
      } satisfies ApiEnvelope<never>,
      { status: error.status },
    );
  }

  // 未知错误：500，不泄露堆栈/内部信息
  return NextResponse.json(
    {
      success: false,
      error: { code: "INTERNAL", message: "internal server error" },
    } satisfies ApiEnvelope<never>,
    { status: 500 },
  );
}

export function unauthorized(message = "unauthorized"): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: "UNAUTHORIZED", message } } satisfies ApiEnvelope<never>,
    { status: 401 },
  );
}

export function forbidden(message = "forbidden"): NextResponse {
  return NextResponse.json(
    { success: false, error: { code: "FORBIDDEN", message } } satisfies ApiEnvelope<never>,
    { status: 403 },
  );
}

/** 路由处理器包装：未捕获异常 → 统一错误信封。 */
export function apiRoute<T>(
  handler: () => Promise<NextResponse<ApiEnvelope<T>>>,
): () => Promise<NextResponse> {
  return async () => {
    try {
      return await handler();
    } catch (error) {
      return fail(error);
    }
  };
}
