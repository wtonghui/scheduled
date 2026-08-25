import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * API-token 纯函数（research.md §9）：LLM 风格 token。
 * 形态：`<prefix>` + 48 字符 base62（均匀无偏）。
 * 存储仅 SHA-256 哈希 + 前 8 位前缀 + 末 4 位；常数时间比较。
 */

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const HASH_ALGORITHM = "sha256";
const BODY_LENGTH = 48;

export interface GeneratedToken {
  /** 明文 token（仅创建时返回一次）。 */
  raw: string;
  /** sha256(raw) hex，入库唯一。 */
  tokenHash: string;
  /** 前 8 位，展示/扫描识别。 */
  prefix: string;
  /** 末 4 位，展示。 */
  lastFour: string;
}

/** Buffer → base62 字符串（BigInt 除法，无模偏差；仅保底 padding）。 */
export function encodeBase62(buf: Buffer): string {
  let value = 0n;
  for (const byte of buf) {
    value = (value << 8n) | BigInt(byte);
  }
  let out = "";
  while (value > 0n) {
    out = BASE62[Number(value % 62n)] + out;
    value /= 62n;
  }
  return out.padStart(BODY_LENGTH, "0");
}

/** 单个 base62 字符：拒绝采样（byte<248）保证无模偏差。 */
function randomBase62Char(): string {
  for (;;) {
    const byte = randomBytes(1)[0]!;
    if (byte < 248) {
      return BASE62[byte % 62]!;
    }
  }
}

export function hashToken(raw: string): string {
  return createHash(HASH_ALGORITHM).update(raw, "utf8").digest("hex");
}

/** 常数时间比较（长度不同返回 false，不做信息泄露）。 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

export function generateToken(prefix = "sche-"): GeneratedToken {
  const body = Array.from({ length: BODY_LENGTH }, () => randomBase62Char()).join("");
  const raw = prefix + body;
  if (raw.length < 12) {
    throw new Error(`token prefix too long: raw length ${raw.length}`);
  }
  return {
    raw,
    tokenHash: hashToken(raw),
    prefix: raw.slice(0, 8),
    lastFour: raw.slice(-4),
  };
}