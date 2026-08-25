import { describe, expect, it } from "vitest";
import {
  ok,
  okCreated,
  noContent,
  fail,
  unauthorized,
  forbidden,
} from "../../src/lib/api-envelope";
import { AppError } from "../../src/lib/errors";

async function read<T>(res: Response): Promise<T> {
  return JSON.parse(await res.text());
}

describe("api-envelope ok/noContent", () => {
  it("wraps data with success http 200", async () => {
    const res = ok({ id: "t1" });
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body).toEqual({ success: true, data: { id: "t1" } });
  });

  it("includes meta when provided", async () => {
    const res = ok([], { page: 1, pageSize: 20, total: 0 });
    const body = await read(res);
    expect(body.meta).toEqual({ page: 1, pageSize: 20, total: 0 });
  });

  it("okCreated returns 201", async () => {
    expect(okCreated({ id: "x" }).status).toBe(201);
  });

  it("noContent returns 204 empty body", async () => {
    const res = noContent();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });
});

describe("api-envelope fail", () => {
  it("maps AppError to status+code, no data", async () => {
    const res = fail(new AppError(404, "NOT_FOUND", "task not found"));
    expect(res.status).toBe(404);
    const body = await read(res);
    expect(body.success).toBe(false);
    expect(body.data).toBeUndefined();
    expect(body.error).toEqual({ code: "NOT_FOUND", message: "task not found" });
  });

  it("carries details array when present", async () => {
    const res = fail(new AppError(400, "VALIDATION", "bad input", ["cron"]));
    const body = await read(res);
    expect(body.error.details).toEqual(["cron"]);
  });

  it("returns 500 INTERNAL for unknown errors without leaking message", async () => {
    const res = fail(new Error("secret internal detail"));
    expect(res.status).toBe(500);
    const body = await read(res);
    expect(body.error).toEqual({ code: "INTERNAL", message: "internal server error" });
  });
});

describe("api-envelope unauthorized/forbidden", () => {
  it("returns 401 with UNAUTHORIZED", async () => {
    const res = unauthorized("bad token");
    expect(res.status).toBe(401);
    const body = await read(res);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body.error.message).toBe("bad token");
  });

  it("returns 403 with FORBIDDEN", async () => {
    const res = forbidden("no scope");
    expect(res.status).toBe(403);
    const body = await read(res);
    expect(body.error.code).toBe("FORBIDDEN");
  });
});