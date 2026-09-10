import { describe, expect, it } from "vitest";
import {
  hasNotificationResults,
  shouldNotifyForStatus,
} from "../../src/modules/notification/service";

const WITH_DATA = { status: 200, data: { ok: true } };
const EMPTY_DATA = { status: 200, data: null };
const NOOP_RESULT = { kind: "noop" };

describe("hasNotificationResults", () => {
  it("true when upstream returned business data", () => {
    expect(hasNotificationResults(WITH_DATA)).toBe(true);
  });

  it("false for null/empty data and noop results", () => {
    expect(hasNotificationResults(EMPTY_DATA)).toBe(false);
    expect(hasNotificationResults(NOOP_RESULT)).toBe(false);
    expect(hasNotificationResults(null)).toBe(false);
    expect(hasNotificationResults(undefined)).toBe(false);
    expect(hasNotificationResults("ok")).toBe(false);
  });
});

describe("shouldNotifyForStatus (mail + webhook same gate)", () => {
  it("failed: only failed notifies (timeout/dead mapped upstream)", () => {
    expect(shouldNotifyForStatus(["failed"], "failed", WITH_DATA)).toBe(true);
    expect(shouldNotifyForStatus(["succeeded"], "failed", WITH_DATA)).toBe(false);
    expect(shouldNotifyForStatus(["succeeded_with_results"], "failed", WITH_DATA)).toBe(false);
    expect(shouldNotifyForStatus([], "failed", WITH_DATA)).toBe(false);
  });

  it("succeeded: plain succeeded wins regardless of results", () => {
    expect(shouldNotifyForStatus(["succeeded"], "succeeded", null)).toBe(true);
    expect(shouldNotifyForStatus(["succeeded", "succeeded_with_results"], "succeeded", null)).toBe(
      true,
    );
    expect(shouldNotifyForStatus([], "succeeded", WITH_DATA)).toBe(false);
  });

  it("succeeded_with_results: only with business data", () => {
    expect(shouldNotifyForStatus(["succeeded_with_results"], "succeeded", WITH_DATA)).toBe(true);
    expect(shouldNotifyForStatus(["succeeded_with_results"], "succeeded", EMPTY_DATA)).toBe(false);
    expect(shouldNotifyForStatus(["succeeded_with_results"], "succeeded", NOOP_RESULT)).toBe(false);
    expect(shouldNotifyForStatus(["succeeded_with_results"], "succeeded")).toBe(false);
  });
});
