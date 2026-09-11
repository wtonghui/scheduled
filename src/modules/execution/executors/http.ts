import { config } from "@/lib/config";
import { decryptJson, decryptSecret } from "@/lib/crypto";
import { HttpError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { MAX_REDIRECTS, checkUrlForSsrf } from "@/lib/ssrf";
import { buildTaskSignature } from "@/modules/webhook/signature";
import type { TaskExecutor } from "../registry";

/**
 * HTTP 执行器（research.md / spec 澄清）：
 * - 2xx = 成功；4xx（除 429）= 永久失败；5xx/429/连接错误/超时 = 可重试（FR-019）。
 * - 执行前 SSRF 校验（结构 + DNS），重定向 ≤3 跳且每跳重新校验（FR-018）。
 * - payload_secrets 在内存解密后注入 params/headers/body，明文不入日志。
 * - 结果完整写入 logger；流式响应（SSE / NDJSON）按 content-type 自动识别，逐 event/行记录。
 * - 流式读取每次取得数据调 onProgress() → withTimeout 空闲计时器续命（长流不被总时长误杀）。
 * - 日志 url 只记 origin+pathname：并入的 params query 可能来自加密 secrets，不能进明文日志。
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

/** 日志里的 url 只记 origin+pathname（query 剔除，避免加密 params 入明文日志）。 */
function logSafeUrl(url: string): string {
  const u = new URL(url);
  u.search = "";
  u.hash = "";
  return u.toString();
}

/**
 * 签名密钥解析：env 共享密钥优先（对方单密钥验签，只能用它）；
 * env 未配则回退任务自生成密钥（对方升级成按任务验签后启用）。
 * 都没有 → null（不签名，原样发出）。
 */
export function resolveSignSecret(
  envSecret: string | undefined,
  perTaskBytes?: Uint8Array | null,
): string | null {
  if (envSecret) {
    return envSecret;
  }
  if (perTaskBytes) {
    return decryptSecret(perTaskBytes);
  }
  return null;
}

type StreamMode = "sse" | "ndjson";

/** 按 content-type 自动识别流式响应；无法识别返回 null（走整包缓冲读取）。 */
function detectStreamMode(contentType: string): StreamMode | null {
  const ct = contentType.toLowerCase();
  if (ct.includes("text/event-stream") || ct.includes("application/event-stream")) {
    return "sse";
  }
  if (ct.includes("ndjson") || ct.includes("jsonl") || ct.includes("stream+json")) {
    return "ndjson";
  }
  return null;
}

/**
 * 解析单个 SSE event 块（空行分隔）：收集所有 `data:` 行值。
 * 跳过 `:` 开头的注释/心跳与 `event:`/`id:`/`retry:` 元数据；多个 `data:` 行以 \n 拼接。
 * 无 data 行返回 null。
 */
function parseSseEventData(block: string): string | null {
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith(":")) {
      continue;
    }
    const match = /^data:\s?(.*)$/.exec(line);
    if (match) {
      data.push(match[1] ?? "");
    }
  }
  return data.length > 0 ? data.join("\n") : null;
}

/** 流式聚合返回值内存上限：防止失控上游撑爆 worker 内存；逐 event 日志仍全量不受影响。 */
const MAX_STREAM_AGGREGATE_BYTES = 8 * 1024 * 1024;

/** 非流式响应整包读取上限：超过即终止并报错（不截断日志、也不把整包压进内存）。 */
export const MAX_RESPONSE_BODY_BYTES = 64 * 1024 * 1024;

/**
 * 有上限地把响应 body 读成字符串：边读边累计，超过 `maxBytes` 即取消并抛错，
 * 防止失控上游（超大 JSON/下载）把 worker 内存撑爆。
 */
export async function readBodyBytesLimited(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
): Promise<string> {
  if (!response.body) {
    return "";
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let result = "";
  let total = 0;
  for (;;) {
    let chunk: Uint8Array;
    try {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunk = value;
    } catch (error) {
      // 中止（超时/任务取消）或流错误
      if (signal.aborted) {
        throw Object.assign(new Error("http request aborted"), { code: "UND_ERR_ABORTED" });
      }
      throw error;
    }
    total += chunk.length;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`http response body exceeded ${maxBytes} bytes`);
    }
    result += decoder.decode(chunk, { stream: true });
  }
  result += decoder.decode();
  return result;
}

interface StreamBodyResult {
  stream: true;
  streamMode: StreamMode;
  events: number;
  bytes: number;
  truncated: boolean;
  data: string[];
}

/**
 * 增量消费流式 body：
 * - 每读到数据调 onProgress() → withTimeout 重置空闲计时器（长流续命，卡死才超时）。
 * - SSE 按空行切 event、提取 data: 行；NDJSON 按行切。
 * - 每个完整 event/行打一条 `http stream event`（含序号与完整 data）；流结束打汇总 `http stream complete`。
 * - 所有 event data 聚合进返回值 `data`（不截断）。
 */
async function readStreamBody(
  response: Response,
  mode: StreamMode,
  signal: AbortSignal,
  taskId: string,
  attempt: number,
  currentUrl: string,
  onProgress: (() => void) | undefined,
): Promise<StreamBodyResult> {
  const started = Date.now();
  const parts: string[] = [];
  let events = 0;
  let bytes = 0;
  let aggregateBytes = 0;
  let truncated = false;

  const emit = (data: string): void => {
    events += 1;
    if (!truncated) {
      if (aggregateBytes + data.length > MAX_STREAM_AGGREGATE_BYTES) {
        truncated = true; // 聚合上限到点：后续只记日志，不再在内存积存大数组
      } else {
        aggregateBytes += data.length;
        parts.push(data);
      }
    }
    logger.info(
      {
        task_id: taskId,
        attempt,
        stream: mode,
        event: events,
        data,
        elapsed_ms: Date.now() - started,
      },
      "http stream event",
    );
  };

  if (!response.body) {
    // 无 body（HEAD / 204 等）：无可逐步记录内容
    return { stream: true, streamMode: mode, events, bytes, truncated, data: parts };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    let chunk: Uint8Array;
    try {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      chunk = value;
    } catch (error) {
      // 中止（超时/任务取消）或流错误
      if (signal.aborted) {
        throw Object.assign(new Error("http request aborted"), { code: "UND_ERR_ABORTED" });
      }
      throw error;
    }
    onProgress?.();
    bytes += chunk.length;
    buffer += decoder.decode(chunk, { stream: true });

    if (mode === "sse") {
      buffer = buffer.replace(/\r\n/g, "\n");
      let sep = buffer.indexOf("\n\n");
      while (sep !== -1) {
        const data = parseSseEventData(buffer.slice(0, sep));
        buffer = buffer.slice(sep + 2);
        if (data !== null) {
          emit(data);
        }
        sep = buffer.indexOf("\n\n");
      }
    } else {
      // ndjson：按行切，跨 chunk 保留不完整行
      let sep = buffer.indexOf("\n");
      while (sep !== -1) {
        const line = buffer.slice(0, sep);
        buffer = buffer.slice(sep + 1);
        if (line.trim().length > 0) {
          emit(line);
        }
        sep = buffer.indexOf("\n");
      }
    }
  }

  // EOF：flush 残留（不换行结尾的最后一个 event/行）
  buffer += decoder.decode();
  const tailBuffer = mode === "sse" ? buffer.replace(/\r\n/g, "\n") : buffer;
  const tailData = mode === "sse" ? parseSseEventData(tailBuffer) : buffer.trim() || null;
  if (tailData !== null) {
    emit(tailData);
  }

  logger.info(
    {
      task_id: taskId,
      attempt,
      stream: mode,
      status: response.status,
      url: logSafeUrl(currentUrl),
      events,
      bytes,
      duration_ms: Date.now() - started,
    },
    "http stream complete",
  );

  return { stream: true, streamMode: mode, events, bytes, truncated, data: parts };
}

export const httpExecutor: TaskExecutor = async ({
  task,
  signal,
  attempt,
  onProgress,
  runId,
  triggerType,
}) => {
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

  // 调度平台回调签名（对接 sqleditor execute-callback）：env 有密钥即全量附带三头。
  // rawBody 取实际发出的精确字节（无 body 按 ""，与对方"空 body 签 t."口径一致）；
  // 平台头覆盖同名用户头；重定向复用同一 fetchInit（t 在对方 300s 容忍窗内有效）。
  // 密钥与签名值永不进日志（本函数所有日志均不含 headers）。
  const signSecret = resolveSignSecret(config.TASK_CALLBACK_SIGN_SECRET, task.execSignSecret);
  if (signSecret) {
    const rawBody = typeof fetchInit.body === "string" ? fetchInit.body : "";
    const timestampSec = Math.floor(Date.now() / 1000);
    headers["X-Scheduled-Signature"] = buildTaskSignature(signSecret, timestampSec, rawBody);
    if (runId) {
      headers["X-Execution-Id"] = runId;
    }
    if (triggerType != null) {
      headers["X-Trigger-Type"] = String(triggerType);
    }
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
      const contentType = response.headers.get("content-type") ?? "";
      const started = Date.now();
      const mode = detectStreamMode(contentType);
      if (mode !== null && response.body) {
        // 流式：逐 step 记录（读取期间每次取得数据续命空闲计时器）
        const streamResult = await readStreamBody(
          response,
          mode,
          signal,
          task.id,
          attempt,
          currentUrl,
          onProgress,
        );
        return { result: { status: response.status, redirects, attempt, ...streamResult } };
      }

      // 非流式：body 按 content-type 解析，非 JSON（或声明 JSON 却解析失败）保留原文。
      // 此前无条件 response.json()，纯文本/空 body 的 2xx 会被 SyntaxError 误判为任务失败。
      const raw = await readBodyBytesLimited(response, signal, MAX_RESPONSE_BODY_BYTES);
      let data: unknown = raw;
      if (contentType.includes("json")) {
        try {
          data = JSON.parse(raw) as unknown;
        } catch {
          // 解析失败保原文，仍按成功处理
        }
      }
      logger.info(
        {
          task_id: task.id,
          attempt,
          status: response.status,
          url: logSafeUrl(currentUrl),
          bytes: raw.length,
          duration_ms: Date.now() - started,
          data,
        },
        "http task ok",
      );
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
