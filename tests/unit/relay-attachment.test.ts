import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadAttachment, sanitizeAttachmentFilename } from "../../worker/relay";

/**
 * P0-2：附件下载逐跳 SSRF 复核（fetch 全 stub，不出网；初始 URL 用字面 IP，
 * 结构检查即过、无需 DNS；跳转目标走真实 checkUrlForSsrf）。
 */

const FILE_URL = "http://127.0.0.1:9/files/report.csv";

function fileResponse(body: string): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/csv", "content-length": String(body.length) },
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

function streamResponse(totalBytes: number, chunkBytes: number): Response {
  let sent = 0;
  const stream = new ReadableStream({
    pull(c) {
      if (sent >= totalBytes) {
        c.close();
        return;
      }
      const n = Math.min(chunkBytes, totalBytes - sent);
      sent += n;
      c.enqueue(new Uint8Array(n));
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sanitizeAttachmentFilename", () => {
  it("keeps the last segment and drops query", () => {
    expect(sanitizeAttachmentFilename("http://x/a/b/c.pdf?token=1")).toBe("c.pdf");
  });

  it("falls back for empty/relative names", () => {
    expect(sanitizeAttachmentFilename("http://x/")).toBe("attachment");
    expect(sanitizeAttachmentFilename("...")).toBe("attachment");
  });

  it("truncates to 128 chars", () => {
    expect(sanitizeAttachmentFilename(`http://x/${"a".repeat(200)}.pdf`)).toHaveLength(128);
  });
});

describe("downloadAttachment", () => {
  it("downloads a direct 200", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fileResponse("a,b\n1,2\n")));
    const att = await downloadAttachment(FILE_URL);
    expect(att?.filename).toBe("report.csv");
    expect(att?.content.toString()).toBe("a,b\n1,2\n");
    expect(att?.contentType).toBe("text/csv");
  });

  it("follows a clean redirect and returns the final body", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url === FILE_URL) {
        return redirectResponse("http://127.0.0.1:9/files/real.csv");
      }
      return fileResponse("real");
    });
    vi.stubGlobal("fetch", fetchMock);
    const att = await downloadAttachment(FILE_URL);
    expect(att?.content.toString()).toBe("real");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("blocks redirect to metadata host without following (target zero hits)", async () => {
    const fetchMock = vi.fn(async () => redirectResponse("http://metadata.google.internal/x"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment(FILE_URL)).resolves.toBeNull();
    // 只发了首跳请求，目标零命中
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_REDIRECTS hops", async () => {
    const fetchMock = vi.fn(async () => redirectResponse("http://127.0.0.1:9/files/loop"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment("http://127.0.0.1:9/files/loop")).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(4); // hop0..3，hop3 达上限
  });

  it("rejects oversize via content-length without reading body", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(null, { status: 200, headers: { "content-length": String(11 * 1024 * 1024) } }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment(FILE_URL)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a blocked initial url without fetching", async () => {
    const fetchMock = vi.fn(async () => fileResponse("x"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment("http://metadata.google.internal/x")).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("link-only over inline limit via content-length (body never read)", async () => {
    // 默认 2MB：3MB 声明直接跳过，连 body 都不读
    const fetchMock = vi.fn(
      async () =>
        new Response(null, {
          status: 200,
          headers: { "content-length": String(3 * 1024 * 1024) },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment(FILE_URL)).resolves.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("custom inline limit admits bigger files", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => fileResponse("big")));
    const att = await downloadAttachment(FILE_URL, 5 * 1024 * 1024);
    expect(att?.content.toString()).toBe("big");
  });

  it("streamed body over limit aborts mid-read (no content-length trust)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamResponse(3 * 1024 * 1024, 512 * 1024)),
    );
    await expect(downloadAttachment(FILE_URL)).resolves.toBeNull();
  });

  it("streamed body within limit attaches", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => streamResponse(100, 64)));
    const att = await downloadAttachment(FILE_URL);
    expect(att?.content.byteLength).toBe(100);
  });

  it("mid-stream error degrades to null instead of throwing", async () => {
    const bad = new Response(
      new ReadableStream({
        start(c) {
          c.error(new Error("boom"));
        },
      }),
      { status: 200 },
    );
    vi.stubGlobal("fetch", vi.fn(async () => bad));
    await expect(downloadAttachment(FILE_URL)).resolves.toBeNull();
  });

  it("inline 0 is link-only mode without any fetch", async () => {
    const fetchMock = vi.fn(async () => fileResponse("x"));
    vi.stubGlobal("fetch", fetchMock);
    await expect(downloadAttachment(FILE_URL, 0)).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
