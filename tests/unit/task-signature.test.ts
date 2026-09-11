import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { encryptSecret } from "../../src/lib/crypto";
import { resolveSignSecret } from "../../src/modules/execution/executors/http";
import { buildTaskSignature, verifyWebhook } from "../../src/modules/webhook/signature";

describe("buildTaskSignature", () => {
  it("matches independent HMAC-SHA256(t.body) computation", () => {
    const secret = "test-secret";
    const t = 1788838253;
    const body = '{"runId":"ex_demo_001","taskId":"tk_demo_001"}';
    const expected = `t=${t},v1=${createHmac("sha256", secret).update(`${t}.${body}`).digest("hex")}`;
    expect(buildTaskSignature(secret, t, body)).toBe(expected);
  });

  it("empty body signs as t + '.' (sqleditor empty-body rule)", () => {
    const t = Math.floor(Date.now() / 1000);
    const header = buildTaskSignature("s", t, "");
    expect(header).toMatch(new RegExp(`^t=${t},v1=[0-9a-f]{64}$`));
    // 我方验签器能验过我方签名器（往返一致）
    expect(verifyWebhook("", header, "s").valid).toBe(true);
  });

  it("different bodies give different signatures", () => {
    const a = buildTaskSignature("s", 100, '{"a":1}');
    const b = buildTaskSignature("s", 100, '{"a":2}');
    expect(a).not.toBe(b);
  });
});

describe("resolveSignSecret (env优先)", () => {
  it("env wins when present", () => {
    const perTask = encryptSecret("per-task-secret");
    expect(resolveSignSecret("env-secret", new Uint8Array(perTask))).toBe("env-secret");
  });

  it("falls back to per-task secret when env missing", () => {
    const perTask = encryptSecret("per-task-secret");
    expect(resolveSignSecret(undefined, new Uint8Array(perTask))).toBe("per-task-secret");
  });

  it("returns null when neither present (unsigned send)", () => {
    expect(resolveSignSecret(undefined, null)).toBeNull();
    expect(resolveSignSecret("", null)).toBeNull();
  });
});
