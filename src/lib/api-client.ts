"use client";

/**
 * 浏览器侧 API 客户端：token 存 localStorage，统一信封解析。
 */

const TOKEN_KEY = "scheduled-api-token";

export function getToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") {
    return;
  }
  if (token === null) {
    window.localStorage.removeItem(TOKEN_KEY);
  } else {
    window.localStorage.setItem(TOKEN_KEY, token);
  }
}

export interface ApiError {
  code: string;
  message: string;
  details?: unknown[];
}

export class ApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details?: unknown[];

  constructor(status: number, code: string, message: string, details?: unknown[]) {
    super(message);
    this.name = "ApiClientError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

interface Envelope<T> {
  success: boolean;
  data?: T;
  error?: ApiError;
  meta?: { page: number; pageSize: number; total: number };
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<{ data: T; meta?: Envelope<T>["meta"] }> {
  const token = getToken();
  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers: {
      ...(token ? { "x-api-token": token } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 204) {
    return { data: undefined as T };
  }

  const body = (await res.json().catch(() => ({}))) as Envelope<T>;
  if (!res.ok || body.success === false || body.error) {
    const error = body.error ?? { code: "INTERNAL", message: `HTTP ${res.status}` };
    throw new ApiClientError(res.status, error.code, error.message, error.details);
  }
  return { data: body.data as T, meta: body.meta };
}

export const api = {
  get<T>(path: string) {
    return request<T>(path);
  },
  post<T>(path: string, body?: unknown) {
    return request<T>(path, { method: "POST", body });
  },
  patch<T>(path: string, body: unknown) {
    return request<T>(path, { method: "PATCH", body });
  },
  del(path: string) {
    return request<undefined>(path, { method: "DELETE" });
  },
};