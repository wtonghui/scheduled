import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskExecutorInput } from "../../src/modules/execution/registry";

const { infoMock } = vi.hoisted(() => ({ infoMock: vi.fn() }));

vi.mock("../../src/lib/logger", () => ({
  logger: { info: infoMock, warn: vi.fn(), error: vi.fn() },
}));

vi.mock("../../src/lib/ssrf", () => ({
  MAX_REDIRECTS: 3,
  checkUrlForSsrf: vi.fn(async () => ({ ok: true })),
}));

import { httpExecutor, readBodyBytesLimited } from "../../src/modules/execution/executors/http";

/**
 * HTTP 执行器单元测试（无 DB）：
 * - 2xx 成功并把完整结果写入 logger（url 只记 origin+pathname，query 剔除）。
 * - 流式（SSE / NDJSON）按 content-type 自动识别，逐 event/行打日志，
 *   每读到一个 chunk 调 onProgress（供 withTimeout 空闲续命）。
 * - 5xx/429 可重试、4xx 永久失败、redirect 逐跳、abort 映射。
 */

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

function taskInput(
  payload: Record<string, unknown>,
  overrides: Partial<TaskExecutorInput> = {},
): TaskExecutorInput {
  return {
    task: { id: "task-1", taskType: "http", payload, payloadSecrets: null, timeoutMs: 30_000 },
    attempt: 1,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** 构造真实流式响应：chunk 逐步推送（短 timer 模拟网络到达）。 */
function streamResponse(chunks: string[], contentType = "text/event-stream"): Response {
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const encoder = new TextEncoder();
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(chunk));
        await new Promise((r) => setTimeout(r, 2));
      }
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": contentType } });
}

function eventsLogged(): Array<[Record<string, unknown>, string]> {
  return infoMock.mock.calls.filter(([, msg]) => msg === "http stream event") as Array<
    [Record<string, unknown>, string]
  >;
}

beforeEach(() => {
  infoMock.mockClear();
  fetchMock.mockReset();
});

describe("httpExecutor · non-streaming", () => {
  it("returns parsed JSON data and logs http task ok with url query stripped", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true, count: 3 }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await httpExecutor(
      taskInput({ url: "https://api.example.test/jobs?token=hidden-secret", method: "GET" }),
    );
    expect(result.result).toMatchObject({
      status: 200,
      redirects: 0,
      data: { ok: true, count: 3 },
    });
    const okLog = infoMock.mock.calls.find(([, msg]) => msg === "http task ok");
    expect(okLog?.[0]).toMatchObject({
      status: 200,
      url: "https://api.example.test/jobs", // query（可能含秘密）不入日志
      data: { ok: true, count: 3 },
    });
  });

  it("keeps raw text when content-type is not json", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response("pong", { status: 200, headers: { "content-type": "text/plain" } }),
    );
    const result = await httpExecutor(taskInput({ url: "https://api.example.test/ping" }));
    expect(result.result).toMatchObject({ status: 200, data: "pong" });
  });

  it("follows redirects manually and re-checks each hop", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(null, { status: 302, headers: { location: "https://api.example.test/final" } }),
    );
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const result = await httpExecutor(taskInput({ url: "https://api.example.test/start" }));
    expect(result.result).toMatchObject({ status: 200, redirects: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("httpExecutor · streaming", () => {
  it("logs each SSE event and aggregates result data", async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse(['data: {"step":1}\n\n', 'data: {"step":2}\n\n', "data: [DONE]\n\n"]),
    );
    const result = await httpExecutor(taskInput({ url: "https://api.example.test/stream" }));
    expect(result.result).toMatchObject({
      status: 200,
      stream: true,
      streamMode: "sse",
      events: 3,
      data: ['{"step":1}', '{"step":2}', "[DONE]"],
    });
    const ev = eventsLogged();
    expect(ev).toHaveLength(3);
    expect(ev[0]?.[0]).toMatchObject({ event: 1, data: '{"step":1}' });
    expect(ev[2]?.[0]).toMatchObject({ event: 3, data: "[DONE]" });
    expect(infoMock.mock.calls.some(([, msg]) => msg === "http stream complete")).toBe(true);
  });

  it("logs each ndjson line", async () => {
    fetchMock.mockResolvedValueOnce(
      streamResponse(['{"a":1}\n', '{"b":2}\n'], "application/x-ndjson"),
    );
    const result = await httpExecutor(taskInput({ url: "https://api.example.test/ndjson" }));
    expect(result.result).toMatchObject({ streamMode: "ndjson", data: ['{"a":1}', '{"b":2}'] });
    const ev = eventsLogged();
    expect(ev).toHaveLength(2);
    expect(ev[1]?.[0]).toMatchObject({ event: 2, data: '{"b":2}' });
  });

  it("merges a single SSE event split across chunks", async () => {
    fetchMock.mockResolvedValueOnce(streamResponse(["data: hello wor", "ld\n\n"]));
    const result = await httpExecutor(taskInput({ url: "https://api.example.test/split" }));
    expect(result.result).toMatchObject({ events: 1, data: ["hello world"] });
  });

  it("calls onProgress for every stream chunk read (idle-timeout keepalive)", async () => {
    const onProgress = vi.fn();
    fetchMock.mockResolvedValueOnce(streamResponse(["data: a\n\n", "data: b\n\n", "data: c\n\n"]));
    await httpExecutor(taskInput({ url: "https://api.example.test/s" }, { onProgress }));
    // 3 次成功 read 都续命；EOF read（done=true）不调
    expect(onProgress.mock.calls.length).toBe(3);
  });
});

describe("httpExecutor · errors", () => {
  it("throws retryable HttpError on 5xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "boom" }), {
        status: 500,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      httpExecutor(taskInput({ url: "https://api.example.test/x" })),
    ).rejects.toMatchObject({ status: 500 });
  });

  it("throws permanent HttpError on 4xx", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "missing" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      httpExecutor(taskInput({ url: "https://api.example.test/x" })),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("maps aborted request to UND_ERR_ABORTED", async () => {
    const controller = new AbortController();
    controller.abort();
    fetchMock.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));
    await expect(
      httpExecutor(taskInput({ url: "https://api.example.test/x" }, { signal: controller.signal })),
    ).rejects.toMatchObject({ code: "UND_ERR_ABORTED" });
  });
});

describe("httpExecutor · non-streaming body limit", () => {
  it("returns the full body while under the cap", async () => {
    const body = await readBodyBytesLimited(
      new Response("hello"),
      new AbortController().signal,
      100,
    );
    expect(body).toBe("hello");
  });

  it("rejects when a non-streaming body exceeds the byte cap", async () => {
    await expect(
      readBodyBytesLimited(new Response("hello world"), new AbortController().signal, 5),
    ).rejects.toThrow(/exceeded 5 bytes/);
  });
});
