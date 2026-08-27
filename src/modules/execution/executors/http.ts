import { decryptJson } from "@/lib/crypto";
import { HttpError } from "@/lib/errors";
import { MAX_REDIRECTS, checkUrlForSsrf } from "@/lib/ssrf";
import type { TaskExecutor } from "../registry";

/**
 * HTTP 执行器（research.md / spec 澄清）：
 * - 2xx = 成功；4xx（除 429）= 永久失败；5xx/429/连接错误/超时 = 可重试（FR-019）。
 * - 执行前 SSRF 校验（结构 + DNS），重定向 ≤3 跳且每跳重新校验（FR-018）。
 * - payload_secrets 在内存解密后注入 params/headers/body，明文不入日志。
 */

/** 把 params 键值对并入 URL query（同名键覆盖；host/path 不变，不影响 SSRF 判定）。 */
function withParams(
  url: string,
  params: Record<string, string | number | boolean> | undefined,
): string {
  if (!params) {
    return url;
  }
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    u.searchParams.set(key, String(value));
  }
  return u.toString();
}

export const httpExecutor: TaskExecutor = async ({ task, signal, attempt }) => {
  const payload = (task.payload ?? {}) as Record<string, unknown>;
  const url = payload.url as string | undefined;
  if (!url) {
    throw new Error("http task requires payload.url");
  }
  const method = (payload.method as string) ?? "GET";

  // 敏感字段解密（内存）
  let secrets: Record<string, unknown> = {};
  if (task.payloadSecrets) {
    secrets = (decryptJson(task.payloadSecrets) ?? {}) as Record<string, unknown>;
  }
  const headers = {
    ...((secrets.headers as Record<string, string> | undefined) ?? {}),
    ...((payload.headers as Record<string, string> | undefined) ?? {}),
  };
  const bodyValue = secrets.body ?? payload.body;
  // query 参数（加密段优先；url 已含的 query 会与原值合并，同名以 params 为准）
  const params = (secrets.params ?? payload.params) as
    | Record<string, string | number | boolean>
    | undefined;

  // SSRF：首次请求（对原始 url 判定；params 只改 query 不改 host）
  const firstCheck = await checkUrlForSsrf(url);
  if (!firstCheck.ok) {
    throw new Error(`ssrf blocked: ${firstCheck.reason}`);
  }

  let currentUrl = withParams(url, params);
  let redirects = 0;
  const fetchInit: RequestInit = {
    method,
    headers,
    redirect: "manual",
    signal,
  };
  if (bodyValue !== undefined && bodyValue !== null && method !== "GET" && method !== "HEAD") {
    fetchInit.body = String(bodyValue);
  }

  for (;;) {
    let response: Response;
    try {
      response = await fetch(currentUrl, fetchInit);
    } catch (error) {
      // 中止（超时）或网络错误
      if (signal.aborted) {
        throw Object.assign(new Error("http request aborted"), { code: "UND_ERR_ABORTED" });
      }
      throw error;
    }

    // 重定向：手动跟随，逐跳 SSRF 复核
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) {
        throw new HttpError(response.status, `redirect without location (HTTP ${response.status})`);
      }
      redirects += 1;
      if (redirects > MAX_REDIRECTS) {
        throw new Error(`too many redirects (max ${MAX_REDIRECTS})`);
      }
      const nextUrl = new URL(location, currentUrl).toString();
      const hopCheck = await checkUrlForSsrf(nextUrl);
      if (!hopCheck.ok) {
        throw new Error(`redirect blocked by ssrf policy: ${hopCheck.reason}`);
      }
      currentUrl = nextUrl;
      continue;
    }

    if (response.status >= 200 && response.status < 300) {
      // 2xx 即成功：body 按 content-type 解析，非 JSON（或声明 JSON 却解析失败）保留原文。
      // 此前无条件 response.json()，纯文本/空 body 的 2xx 会被 SyntaxError 误判为任务失败。
      const raw = await response.text();
      const contentType = response.headers.get("content-type") ?? "";
      let data: unknown = raw;
      if (contentType.includes("json")) {
        try {
          data = JSON.parse(raw) as unknown;
        } catch {
          // 解析失败保原文，仍按成功处理
        }
      }
      return { result: { status: response.status, redirects, attempt, data } };
    }

    // 429 与 5xx → 可重试
    if (response.status === 429 || response.status >= 500) {
      throw new HttpError(response.status, `upstream HTTP ${response.status} (retryable)`);
    }

    // 4xx（除 429）→ 永久失败
    throw new HttpError(response.status, `upstream HTTP ${response.status} (permanent)`);
  }
};
