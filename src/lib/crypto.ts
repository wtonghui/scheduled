import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { Buffer } from "node:buffer";
import { config } from "./config";

/**
 * AES-256-GCM 加解密（data-model.md 加密策略落地）。
 * 密文格式：`[12B nonce][ciphertext][16B auth tag]`，单 Buffer 存储。
 * 密钥来自 PAYLOAD_ENCRYPTION_KEY（config，32 字节）。
 * 明文绝不入库/日志，仅执行时在内存解密。
 */

const ALGORITHM = "aes-256-gcm";
const NONCE_LENGTH = 12;
const TAG_LENGTH = 16;

export function encryptSecret(plaintext: string): Buffer {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv(ALGORITHM, config.payloadEncryptionKey, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([nonce, ciphertext, tag]);
}

export function decryptSecret(ciphertext: Uint8Array): string {
  if (ciphertext.length < NONCE_LENGTH + TAG_LENGTH) {
    throw new Error("ciphertext too short");
  }
  const nonce = ciphertext.subarray(0, NONCE_LENGTH);
  const tag = ciphertext.subarray(ciphertext.length - TAG_LENGTH);
  const data = ciphertext.subarray(NONCE_LENGTH, ciphertext.length - TAG_LENGTH);
  const decipher = createDecipheriv(ALGORITHM, config.payloadEncryptionKey, nonce);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

/** 加密任意 JSON 值（如 payload_secrets 的对象部分）。 */
export function encryptJson(value: unknown): Buffer {
  return encryptSecret(JSON.stringify(value));
}

/** 解密并解析 JSON。篡改/密钥错误会抛错（GCM 认证失败）。 */
export function decryptJson(ciphertext: Uint8Array): unknown {
  return JSON.parse(decryptSecret(ciphertext));
}

/** 生成 Webhook HMAC 密钥（32 字节随机 hex）。 */
export function generateWebhookSecret(): string {
  return randomBytes(32).toString("hex");
}