import { describe, expect, it } from "vitest";
import { serializeDates, toBeijingIso } from "../../src/lib/datetime";

describe("toBeijingIso", () => {
  it("converts a UTC instant to Beijing wall clock with explicit +08:00 offset", () => {
    expect(toBeijingIso(new Date("2026-08-25T02:00:00.000Z"))).toBe(
      "2026-08-25T10:00:00.000+08:00",
    );
  });

  it("rolls over the date when shifting crosses midnight", () => {
    expect(toBeijingIso(new Date("2026-08-25T16:30:05.123Z"))).toBe(
      "2026-08-26T00:30:05.123+08:00",
    );
  });

  it("round-trips losslessly through new Date()", () => {
    const instant = new Date("2026-01-01T12:34:56.789Z");
    expect(new Date(toBeijingIso(instant)).getTime()).toBe(instant.getTime());
  });
});

describe("serializeDates", () => {
  it("converts nested Date instances inside objects and arrays", () => {
    const d = new Date("2026-08-25T02:00:00.000Z");
    const out = serializeDates({
      nextRunAt: d,
      list: [d, null],
      name: "t",
    }) as Record<string, unknown>;

    expect(out.nextRunAt).toBe("2026-08-25T10:00:00.000+08:00");
    expect((out.list as unknown[])[0]).toBe("2026-08-25T10:00:00.000+08:00");
    expect((out.list as unknown[])[1]).toBeNull();
    expect(out.name).toBe("t");
  });

  it("passes primitives through untouched", () => {
    expect(serializeDates(42)).toBe(42);
    expect(serializeDates(null)).toBeNull();
    expect(serializeDates("x")).toBe("x");
  });

  it("converts BigInt values to strings (JSON-safe)", () => {
    const out = serializeDates({ id: 9007199254740993n, name: "t" }) as Record<string, unknown>;
    expect(out.id).toBe("9007199254740993");
    expect(typeof out.id).toBe("string");
  });

  it("does not dismantle non-plain objects such as Buffer", () => {
    const buf = Buffer.from([1, 2, 3]);
    expect(serializeDates(buf)).toBe(buf);
  });
});
