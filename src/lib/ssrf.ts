import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { config } from "./config";

/**
 * SSRF 强制防护（FR-018）：拒绝 loopback/RFC1918/链路本地/云元数据 IP，
 * DNS 解析后复核，限重定向（MAX_REDIRECTS，跳数由 HTTP 执行器执行）。
 *
 * 测试开关 `SSRF_ALLOW_PRIVATE`（生产默认 false）仅放宽"私网/环回 IP 范围"检查，
 * 协议/主机名/元数据等结构检查始终严格——不影响 create 时对非法协议 URL 的拒绝。
 */

export const MAX_REDIRECTS = 3;

export type SsrfVerdict = { ok: true } | { ok: false; reason: string };

/** 判断单一 IP 是否被禁止访问。allowPrivate=true 仅放行私网/环回范围，其余类别仍禁。 */
export function isBlockedIp(ip: string, allowPrivate = config.SSRF_ALLOW_PRIVATE): boolean {
  let addr: ipaddr.IPv4 | ipaddr.IPv6;
  try {
    addr = ipaddr.process(ip);
  } catch {
    return true; // 未解析的地址一律拒绝
  }

  if (addr.kind() === "ipv4") {
    const v4 = addr as ipaddr.IPv4;
    if (
      v4.range() === "unspecified" ||
      v4.range() === "multicast" ||
      v4.range() === "reserved" ||
      v4.range() === "broadcast"
    ) {
      return true;
    }
    if (
      v4.range() === "loopback" ||
      v4.range() === "private" ||
      v4.range() === "linkLocal" ||
      v4.range() === "carrierGradeNat"
    ) {
      return !allowPrivate;
    }
    return false;
  }

  const v6 = addr as ipaddr.IPv6;
  if (v6.isIPv4MappedAddress() && isBlockedIp(v6.toIPv4Address().toString(), allowPrivate)) {
    return true;
  }
  if (v6.range() === "unspecified" || v6.range() === "multicast" || v6.range() === "reserved") {
    return true;
  }
  if (v6.range() === "loopback" || v6.range() === "uniqueLocal" || v6.range() === "linkLocal") {
    return !allowPrivate;
  }
  return false;
}

/** 禁止的主机名模式（云元数据 / docker 内部别名）——任何模式下均禁止。 */
const BLOCKED_HOSTNAME_PATTERNS: RegExp[] = [
  /^metadata\./i,
  /\.internal$/i, // metadata.google.internal 等
  /^instance-data\b/i,
  /^169\.254\.169\.254[.-]/,
];

export function isBlockedHostname(
  hostname: string,
  allowLocalhost = config.SSRF_ALLOW_LOCALHOST,
): boolean {
  const host = hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost")) {
    return !allowLocalhost;
  }
  return BLOCKED_HOSTNAME_PATTERNS.some((re) => re.test(host));
}

/** 校验 URL 结构 + 主机名/IP（不发起 DNS）。allowPrivate 放宽私网 IP；allowLocalhost 放行 localhost 主机名。 */
export function checkHttpUrl(
  url: string,
  allowPrivate = config.SSRF_ALLOW_PRIVATE,
  allowLocalhost = config.SSRF_ALLOW_LOCALHOST,
): SsrfVerdict {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "invalid URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: `unsupported protocol: ${parsed.protocol}` };
  }

  // URL.hostname 对 IPv6 保留 [ ]，剥去后再校验
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (isBlockedHostname(hostname, allowLocalhost)) {
    return { ok: false, reason: "blocked hostname" };
  }

  // 字面 IP
  if (ipaddr.isValid(hostname)) {
    return isBlockedIp(hostname, allowPrivate)
      ? { ok: false, reason: "blocked IP address" }
      : { ok: true };
  }

  return { ok: true };
}

/** DNS 解析后复核所有解析 IP 均为公网。allowPrivate 放宽私网 IP；allowLocalhost 放行 localhost 主机名。 */
export async function checkDnsForSsrf(
  hostname: string,
  allowPrivate = config.SSRF_ALLOW_PRIVATE,
  allowLocalhost = config.SSRF_ALLOW_LOCALHOST,
): Promise<SsrfVerdict> {
  if (isBlockedHostname(hostname, allowLocalhost)) {
    return { ok: false, reason: "blocked hostname" };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(hostname, { all: true });
  } catch {
    return { ok: false, reason: "dns resolution failed" };
  }

  if (addresses.length === 0) {
    return { ok: false, reason: "no addresses resolved" };
  }

  for (const { address } of addresses) {
    if (isBlockedIp(address, allowPrivate)) {
      return {
        ok: false,
        reason: `resolved address blocked: ${address} (host ${hostname})`,
      };
    }
  }

  return { ok: true };
}

/** 完整校验：结构 + 主机名 + DNS 解析复核。 */
export async function checkUrlForSsrf(url: string): Promise<SsrfVerdict> {
  const structural = checkHttpUrl(url);
  if (!structural.ok) {
    return structural;
  }
  const parsed = new URL(url);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (ipaddr.isValid(hostname)) {
    return { ok: true };
  }
  return checkDnsForSsrf(hostname);
}
