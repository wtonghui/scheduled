import { describe, expect, it } from "vitest";
import { buildDegradedOutbox } from "../../src/modules/execution/service";
import type { NotifyContext, RunSummary } from "../../src/modules/notification/service";

/**
 * 降级通知兜底（删自愈补单的前提）：纯字符串拼接，永不抛；
 * emailExpected/webhookExpected=true 就一定有行。
 */

function ctx(overrides: Partial<NotifyContext> = {}): NotifyContext {
  return {
    tenantId: "tenant-1",
    taskId: "task-1",
    taskName: "nightly",
    recipients: ["ops@example.com"],
    notifyOn: ["succeeded", "failed"],
    webhookUrl: "http://127.0.0.1:9/hook",
    webhookSecretBytes: null,
    ...overrides,
  };
}

function summary(overrides: Partial<RunSummary> = {}): RunSummary {
  return {
    executionId: "exec-1",
    taskId: "task-1",
    taskName: "nightly",
    status: "succeeded",
    scheduledAt: new Date("2026-10-15T00:00:00.000Z"),
    startedAt: new Date("2026-10-15T00:00:01.000Z"),
    finishedAt: new Date("2026-10-15T00:00:02.000Z"),
    durationMs: 1000,
    ...overrides,
  };
}

const fields = {
  status: "succeeded" as const,
  startedAt: new Date("2026-10-15T00:00:01.000Z"),
  finishedAt: new Date("2026-10-15T00:00:02.000Z"),
  durationMs: 1000,
};

describe("buildDegradedOutbox never throws", () => {
  it("期望都为 true 时邮件 + webhook 都有行", () => {
    const out = buildDegradedOutbox(ctx(), summary(), fields, null, true, true);
    expect(out.email?.toAddress).toContain("ops@example.com");
    expect(out.email?.subject).toContain("降级通知");
    expect(out.email?.attachmentUrl).toBeNull();
    expect(out.webhook?.url).toBe("http://127.0.0.1:9/hook");
    expect(JSON.stringify(out.webhook?.payload)).toContain("exec-1");
  });

  it("emailExpected=false 时无邮件部分（后开邮件的旧 run 语义）", () => {
    const out = buildDegradedOutbox(ctx(), summary(), fields, null, false, true);
    expect(out.email).toBeUndefined();
    expect(out.webhook?.url).toBeTruthy();
  });

  it("webhookExpected=false 或无 url 时无回调部分", () => {
    const out = buildDegradedOutbox(ctx({ webhookUrl: null }), summary(), fields, null, true, false);
    expect(out.email?.subject).toBeTruthy();
    expect(out.webhook).toBeUndefined();
  });

  it("任务名含 HTML 标签被转义且不抛，失败带 error 行", () => {
    const out = buildDegradedOutbox(
      ctx({ taskName: "<script>alert(1)</script>" }),
      summary({ status: "failed" }),
      { ...fields, status: "failed" },
      "boom",
      true,
      false,
    );
    expect(out.email?.html).not.toContain("<script>");
    expect(out.email?.html).toContain("&lt;script&gt;");
    expect(out.email?.text).toContain("Error: boom");
  });
});
