import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook HMAC 签名（contracts/api.md / data-model 投递契约）：
 * `X-Scheduled-Signature: t=<unix>,v1=<hmac-sha256(t<body>, secret)>`
 */

const SIGNATURE_PREFIX = "t=";

/**
 * 任务执行请求签名（对接 sqleditor execute-callback）与 Webhook 出站签名同构：
 * `X-Scheduled-Signature: t=<unix>,v1=<hmac-sha256(t<body>, secret)>`。
 * 纯函数（时间可注入），签名向量可测；空 body 按 "" 参与签名。
 */
export function buildTaskSignature(
  secret: string,
  timestampSec: number,
  rawBody: string | Buffer,
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSec}.`)
    .update(rawBody)
    .digest("hex");
  return `${SIGNATURE_PREFIX}${timestampSec},v1=${signature}`;
}

export function signWebhook(body: string | Buffer, secret: string): string {
  return buildTaskSignature(secret, Math.floor(Date.now() / 1000), body);
}

export interface VerifiedSignature {
  timestamp: number;
  valid: boolean;
}

/** 验签：解析 t/v1，重放窗口 `maxAgeSeconds`，常数时间比较。 */
export function verifyWebhook(
  body: string | Buffer,
  signatureHeader: string | null | undefined,
  secret: string,
  maxAgeSeconds = 300,
): VerifiedSignature {
  if (!signatureHeader) {
    return { timestamp: 0, valid: false };
  }
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/i.exec(signatureHeader);
  if (!match) {
    return { timestamp: 0, valid: false };
  }
  const timestamp = Number(match[1]);
  const provided = match[2]!;
  const expected = createHmac("sha256", secret).update(`${timestamp}.`).update(body).digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  const now = Math.floor(Date.now() / 1000);
  return {
    timestamp,
    valid:
      providedBuf.length === expectedBuf.length &&
      timingSafeEqual(providedBuf, expectedBuf) &&
      Math.abs(now - timestamp) <= maxAgeSeconds,
  };
}
