import { afterEach, describe, expect, it, vi } from "vitest";
import { perTenantShare, pickStart, rotatedOrder } from "../../src/lib/fairness";
import { MemoryBreakerStore } from "../../worker/webhook-relay";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("perTenantShare", () => {
  it("splits the batch evenly with at least one per tenant", () => {
    expect(perTenantShare(20, 1)).toBe(20);
    expect(perTenantShare(20, 2)).toBe(10);
    expect(perTenantShare(20, 3)).toBe(7);
    expect(perTenantShare(20, 50)).toBe(1);
  });

  it("returns the full limit with no tenants", () => {
    expect(perTenantShare(20, 0)).toBe(20);
  });
});

describe("rotatedOrder", () => {
  it("rotates from a random start and wraps around", () => {
    expect(rotatedOrder(["a", "b", "c"], 0)).toEqual(["a", "b", "c"]);
    expect(rotatedOrder(["a", "b", "c"], 1)).toEqual(["b", "c", "a"]);
    expect(rotatedOrder(["a", "b", "c"], 5)).toEqual(["c", "a", "b"]);
    expect(rotatedOrder([], 3)).toEqual([]);
  });

  it("picks a start within range", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);
    expect(pickStart(3)).toBe(2);
    expect(pickStart(0)).toBe(0);
  });
});

describe("MemoryBreakerStore", () => {
  it("opens after threshold failures with jittered cooldown", () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // factor 0.8
    const store = new MemoryBreakerStore(2, 1000);
    const now = 1_000_000;
    store.onFailure("h.test", now);
    expect(store.isOpen("h.test", now)).toBe(false);
    store.onFailure("h.test", now);
    expect(store.isOpen("h.test", now)).toBe(true);
    expect(store.openUntil("h.test")).toBe(now + 800);
    // 冷却内仍开，过期后自动关
    expect(store.isOpen("h.test", now + 799)).toBe(true);
    expect(store.isOpen("h.test", now + 800)).toBe(false);
  });

  it("success clears the host", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const store = new MemoryBreakerStore(1, 1000);
    const now = 2_000_000;
    store.onFailure("h.test", now);
    expect(store.isOpen("h.test", now)).toBe(true);
    store.onSuccess("h.test");
    expect(store.isOpen("h.test", now)).toBe(false);
    expect(store.openUntil("h.test")).toBe(0);
  });
});
