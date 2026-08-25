import { describe, expect, it } from "vitest";
import {
  generateToken,
  hashToken,
  safeEqual,
  encodeBase62,
} from "../../src/modules/auth/tokens";

describe("generateToken", () => {
  it("produces sche- prefixed 53-char token (5 + 48)", () => {
    const { raw } = generateToken();
    expect(raw.startsWith("sche-")).toBe(true);
    expect(raw.length).toBe(5 + 48);
    expect(raw.slice(5)).toMatch(/^[0-9A-Za-z]{48}$/);
  });

  it("honors custom prefix", () => {
    const { raw } = generateToken("sk-");
    expect(raw.startsWith("sk-")).toBe(true);
  });

  it("is globally unique-ish (no repeats across calls)", () => {
    const seen = new Set(Array.from({ length: 100 }, () => generateToken().raw));
    expect(seen.size).toBe(100);
  });

  it("derives tokenHash/prefix/lastFour consistently", () => {
    const t = generateToken();
    expect(t.tokenHash).toBe(hashToken(t.raw));
    expect(t.prefix).toBe(t.raw.slice(0, 8));
    expect(t.lastFour).toBe(t.raw.slice(-4));
  });
});

describe("hashToken", () => {
  it("is sha256 hex (64 chars)", () => {
    expect(hashToken("sche-test")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is deterministic", () => {
    expect(hashToken("abc")).toBe(hashToken("abc"));
  });
});

describe("encodeBase62", () => {
  it("pads to 48 chars", () => {
    expect(encodeBase62(Buffer.alloc(36))).toHaveLength(48);
  });

  it("is deterministic for the same bytes", () => {
    const buf = Buffer.from("1234567890abcdef");
    expect(encodeBase62(buf)).toBe(encodeBase62(buf));
  });
});

describe("safeEqual", () => {
  it("returns true for identical strings", () => {
    expect(safeEqual("sche-aabbcc", "sche-aabbcc")).toBe(true);
  });

  it("returns false for different content", () => {
    expect(safeEqual("sche-aaaa", "sche-bbbb")).toBe(false);
  });

  it("returns false for different lengths without throwing", () => {
    expect(safeEqual("short", "a-much-longer-value")).toBe(false);
  });
});