import { describe, expect, it } from "vitest";
import { renderTemplate } from "../../src/lib/template";

describe("renderTemplate", () => {
  const ctx = {
    taskName: "对账",
    status: "succeeded",
    runId: "ex123",
    httpStatus: 200,
    body: {
      code: 200,
      msg: "回调已接收，验签通过",
      data: {
        rowCount: 1286,
        fileUrl: "https://minio.example.com/result.xlsx",
        fileSize: 1887436,
        fileType: "xlsx",
      },
    },
  };

  it("replaces simple top-level placeholders", () => {
    expect(renderTemplate("[{taskName}] 状态={status}", ctx)).toBe("[对账] 状态=succeeded");
  });

  it("replaces nested body placeholders", () => {
    expect(renderTemplate("{body.msg} — {body.data.rowCount} 行", ctx)).toBe(
      "回调已接收，验签通过 — 1286 行",
    );
  });

  it("keeps original {xxx} when path not found", () => {
    expect(renderTemplate("{body.nonexistent} done", ctx)).toBe("{body.nonexistent} done");
  });

  it("keeps original when mid-path is undefined", () => {
    expect(renderTemplate("{body.missing.deep}", ctx)).toBe("{body.missing.deep}");
  });

  it("renders null as empty string", () => {
    expect(renderTemplate("[{body.nullField}]", { ...ctx, body: { nullField: null } })).toBe("[]");
  });

  it("stringifies object values as JSON", () => {
    const result = renderTemplate("{body.data}", ctx);
    expect(result).toContain("rowCount");
    expect(result).toContain("1286");
  });

  it("handles httpStatus from execution metadata", () => {
    expect(renderTemplate("HTTP {httpStatus}", ctx)).toBe("HTTP 200");
  });

  it("no placeholders → returns as-is", () => {
    expect(renderTemplate("plain text no placeholders", ctx)).toBe("plain text no placeholders");
  });

  it("multiple occurrences of same placeholder", () => {
    expect(renderTemplate("{body.data.rowCount} and {body.data.rowCount}", ctx)).toBe(
      "1286 and 1286",
    );
  });
});
