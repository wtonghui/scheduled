import { describe, expect, it } from "vitest";
import { businessFailureMessage } from "../../src/modules/execution/service";

function resultOf(data: unknown) {
  return { status: 200, redirects: 0, attempt: 1, data };
}

describe("businessFailureMessage (automatic, no task config)", () => {
  it("returns null on business success (numeric 200)", () => {
    expect(businessFailureMessage(resultOf({ code: 200, msg: "成功", data: {} }))).toBeNull();
  });

  it("returns outer msg on business failure", () => {
    expect(
      businessFailureMessage(
        resultOf({ code: 0, msg: "SQL 执行超时", data: { taskName: "任务名" } }),
      ),
    ).toBe("SQL 执行超时");
  });

  it("treats string \"200\" as failure (only numeric 200 succeeds)", () => {
    expect(businessFailureMessage(resultOf({ code: "200", msg: "成功" }))).toBe("成功");
  });

  it("falls back to business code when msg is missing", () => {
    expect(businessFailureMessage(resultOf({ code: 0, data: {} }))).toBe("business code 0");
  });

  it("ignores responses without a code field (legacy {ok:true} unaffected)", () => {
    expect(businessFailureMessage(resultOf({ ok: true }))).toBeNull();
    expect(businessFailureMessage(resultOf("pong"))).toBeNull();
    expect(businessFailureMessage(resultOf(null))).toBeNull();
  });
});
