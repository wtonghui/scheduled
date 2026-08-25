import { describe, expect, it } from "vitest";
import {
  MAX_REDIRECTS,
  checkDnsForSsrf,
  checkHttpUrl,
  checkUrlForSsrf,
  isBlockedHostname,
  isBlockedIp,
} from "../../src/lib/ssrf";

describe("ssrf checkHttpUrl (structural)", () => {
  it("accepts a public https url", () => {
    expect(checkHttpUrl("https://example.com/health?q=1")).toEqual({ ok: true });
  });

  it("blocks non-http(s) schemes", () => {
    expect(checkHttpUrl("file:///etc/passwd")).toEqual({
      ok: false,
      reason: "unsupported protocol: file:",
    });
    expect(checkHttpUrl("ftp://example.com/")).toEqual({
      ok: false,
      reason: "unsupported protocol: ftp:",
    });
  });

  it("blocks loopback and private IPv4 literals (strict mode)", () => {
    // 测试 setup 默认 SSRF_ALLOW_PRIVATE=true（本地测试服务器），此处显式 strict
    expect(checkHttpUrl("http://127.0.0.1/", false).ok).toBe(false);
    expect(checkHttpUrl("http://10.0.0.5/x", false).ok).toBe(false);
    expect(checkHttpUrl("http://192.168.1.1/x", false).ok).toBe(false);
    expect(checkHttpUrl("http://172.16.0.1/x", false).ok).toBe(false);
  });

  it("blocks link-local and cloud metadata addresses (strict mode)", () => {
    expect(checkHttpUrl("http://169.254.169.254/latest/meta-data/", false).ok).toBe(false);
    expect(checkHttpUrl("http://169.254.10.1/", false).ok).toBe(false);
  });

  it("blocks IPv6 loopback/ULA/link-local (strict mode)", () => {
    expect(checkHttpUrl("http://[::1]/", false).ok).toBe(false);
    expect(checkHttpUrl("http://[fc00::1]/", false).ok).toBe(false);
    expect(checkHttpUrl("http://[fe80::1]/", false).ok).toBe(false);
  });

  it("allows private literals when explicitly permitted", () => {
    expect(checkHttpUrl("http://127.0.0.1/", true).ok).toBe(true);
  });

  it("blocks metadata/docker hosts", () => {
    expect(checkHttpUrl("http://metadata.google.internal/").ok).toBe(false);
    expect(checkHttpUrl("http://metadata.aws.company.com/").ok).toBe(false);
    // localhost 默认拒（显式 allowLocalhost=false，不依赖环境开关）
    expect(checkHttpUrl("http://localhost/", false, false).ok).toBe(false);
  });

  it("rejects invalid URL", () => {
    expect(checkHttpUrl("not-a-url").ok).toBe(false);
  });
});

describe("ssrf localhost / private allow (内网部署开关)", () => {
  it("allows localhost hostname when allowLocalhost=true", () => {
    expect(checkHttpUrl("http://localhost:3000/x", false, true).ok).toBe(true);
    expect(checkHttpUrl("http://api.localhost/x", false, true).ok).toBe(true);
    expect(isBlockedHostname("localhost", true)).toBe(false);
  });

  it("blocks localhost when allowLocalhost unset", () => {
    expect(isBlockedHostname("localhost", false)).toBe(true);
  });

  it("private IPv4 allowed when allowPrivate=true (even with allowLocalhost=false)", () => {
    expect(checkHttpUrl("http://10.0.0.8:8080/x", true, false).ok).toBe(true);
    expect(checkHttpUrl("http://192.168.1.10/x", true, false).ok).toBe(true);
  });

  it("metadata stays blocked even with both switches on", () => {
    expect(checkHttpUrl("http://metadata.google.internal/", true, true).ok).toBe(false);
    expect(checkHttpUrl("http://metadata.aws.company.com/", true, true).ok).toBe(false);
  });
});

describe("ssrf isBlockedIp / isBlockedHostname", () => {
  it("classifies ranges (strict mode)", () => {
    expect(isBlockedIp("127.0.0.1", false)).toBe(true);
    expect(isBlockedIp("10.1.2.3", false)).toBe(true);
    expect(isBlockedIp("169.254.169.254", false)).toBe(true);
    expect(isBlockedIp("8.8.8.8", false)).toBe(false);
    expect(isBlockedIp("::1", false)).toBe(true);
    // 默认取自 config.SSRF_ALLOW_PRIVATE（测试环境为 true）→ 放行私网
    expect(isBlockedIp("127.0.0.1")).toBe(false);
  });

  it("classifies hostnames", () => {
    expect(isBlockedHostname("metadata.google.internal")).toBe(true);
    expect(isBlockedHostname("api.internals.example.com")).toBe(false);
    expect(isBlockedHostname("example.com")).toBe(false);
  });
});

describe("ssrf checkDnsForSsrf / checkUrlForSsrf", () => {
  it("rejects localhost via DNS by default (explicit strict)", async () => {
    const verdict = await checkDnsForSsrf("localhost", false, false);
    expect(verdict.ok).toBe(false);
  });

  it("allows localhost via DNS when both switches on", async () => {
    // localhost 解析到 127.0.0.1：需 allowLocalhost + allowPrivate 同时放行
    const verdict = await checkDnsForSsrf("localhost", true, true);
    expect(verdict.ok).toBe(true);
  });

  it("accepts a public hostname via DNS", async () => {
    const verdict = await checkDnsForSsrf("example.com");
    expect(verdict.ok).toBe(true);
  });

  it("checkUrlForSsrf combines structural + DNS checks", async () => {
    // 协议检查始终严格（即使 IP 范围放行）
    expect((await checkUrlForSsrf("ftp://example.com/health")).ok).toBe(false);
    expect((await checkUrlForSsrf("file:///etc/passwd")).ok).toBe(false);
    expect((await checkUrlForSsrf("https://example.com/path")).ok).toBe(true);
    // 元数据主机名始终禁止
    expect((await checkUrlForSsrf("http://metadata.google.internal/latest")).ok).toBe(false);
  });
});

describe("ssrf constants", () => {
  it("limits redirects", () => {
    expect(MAX_REDIRECTS).toBeGreaterThan(0);
    expect(MAX_REDIRECTS).toBeLessThanOrEqual(5);
  });
});
