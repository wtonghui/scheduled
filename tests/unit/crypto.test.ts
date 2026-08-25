import { describe, expect, it } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  encryptJson,
  decryptJson,
  generateWebhookSecret,
} from "../../src/lib/crypto";

describe("crypto (AES-256-GCM)", () => {
  it("round-trips a secret", () => {
    const plaintext = "Authorization: Bearer abc-def-123";
    const encrypted = encryptSecret(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it("produces a different ciphertext per encryption (random nonce)", () => {
    const plaintext = "same value";
    expect(encryptSecret(plaintext).equals(encryptSecret(plaintext))).toBe(false);
  });

  it("ciphertext format is nonce(12) + ct + tag(16)", () => {
    const encrypted = encryptSecret("x");
    expect(encrypted.length).toBe(12 + 1 + 16);
  });

  it("rejects tampered ciphertext (GCM auth tag)", () => {
    const encrypted = encryptSecret("integrity check");
    const tampered = Buffer.from(encrypted);
    tampered[20] ^= 0x01;
    expect(() => decryptSecret(tampered)).toThrow();
  });

  it("rejects truncated ciphertext", () => {
    const encrypted = encryptSecret("payload");
    expect(() => decryptSecret(encrypted.subarray(0, 10))).toThrow("too short");
  });

  it("round-trips JSON values", () => {
    const value = { headers: { authorization: "Bearer secret" }, key: 42 };
    const encrypted = encryptJson(value);
    expect(decryptJson(encrypted)).toEqual(value);
  });

  it("generates a 64-char hex webhook secret", () => {
    const secret = generateWebhookSecret();
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
    expect(secret).not.toBe(generateWebhookSecret());
  });
});