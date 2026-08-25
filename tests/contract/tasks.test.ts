import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { GET as listGET, POST } from "../../src/app/api/v1/tasks/route";
import { GET as itemGET, PATCH, DELETE } from "../../src/app/api/v1/tasks/[id]/route";
import { POST as runNowPOST } from "../../src/app/api/v1/tasks/[id]/run-now/route";
import { createTestTenant, createTestToken, cleanupTenant } from "../integration/helpers";

/**
 * US1 契约测试（T016）：按 contracts/api.md 断言 HTTP 信封与状态码。
 * 直接调用 route handler（虚拟请求），验证 401/403/400/201/409/404。
 */

const BASE = "http://localhost/api/v1";

function req(
  url: string,
  options: { method?: string; body?: unknown; token?: string } = {},
): NextRequest {
  return new NextRequest(url, {
    method: options.method ?? "GET",
    headers: {
      ...(options.token ? { "x-api-token": options.token } : {}),
      ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
    },
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });
}

async function json(res: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await res.text());
}

describe("tasks HTTP contract", () => {
  let tenantId: string;
  let readToken: string;
  let writeToken: string;
  let scopedManager: string;
  let createdId: string;
  let createdVersion: number;

  beforeAll(async () => {
    const tenant = await createTestTenant("contract");
    tenantId = tenant.id;
    const read = await createTestToken(tenantId, ["tasks:read"], "read");
    const write = await createTestToken(tenantId, ["tasks:read", "tasks:write"], "write");
    const manager = await createTestToken(tenantId, ["tokens:manage"], "manager");
    readToken = read.token;
    writeToken = write.token;
    scopedManager = manager.token;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
  });

  it("returns 200 without a token (anonymous cross-tenant read)", async () => {
    const res = await listGET(req(`${BASE}/tasks`));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data)).toBe(true);
  });

  it("returns 200 for a valid token regardless of read scope (read is open)", async () => {
    const res = await listGET(req(`${BASE}/tasks`, { token: scopedManager }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.success).toBe(true);
  });

  it("POST without a token → 401 (writes still require auth)", async () => {
    const res = await POST(
      req(`${BASE}/tasks`, {
        method: "POST",
        body: {
          name: "anon-create-blocked",
          cron: "*/5 * * * *",
          taskType: "noop",
          payload: {},
          recipients: ["ops@example.com"],
        },
      }),
    );
    expect(res.status).toBe(401);
  });

  it("POST creates a task → 201 with envelope", async () => {
    const res = await POST(
      req(`${BASE}/tasks`, {
        method: "POST",
        body: {
          name: "contract-task",
          cron: "*/5 * * * *",
          taskType: "noop",
          payload: {},
          recipients: ["ops@example.com"],
        },
        token: writeToken,
      }),
    );
    expect(res.status).toBe(201);
    const body = await json(res);
    expect(body.success).toBe(true);
    const data = body.data as { id: string; version: number; nextRunAt?: string };
    expect(data.id).toBeTruthy();
    expect(data.version).toBe(1);
    expect(data.nextRunAt).toBeTruthy();
    createdId = data.id;
    createdVersion = data.version;
  });

  it("POST with invalid cron → 400 VALIDATION", async () => {
    const res = await POST(
      req(`${BASE}/tasks`, {
        method: "POST",
        body: {
          name: "bad",
          cron: "not valid",
          recipients: ["ops@example.com"],
        },
        token: writeToken,
      }),
    );
    expect(res.status).toBe(400);
    const body = await json(res);
    expect((body.error as { code: string }).code).toBe("VALIDATION");
  });

  it("GET list returns paginated envelope", async () => {
    const res = await listGET(req(`${BASE}/tasks?page=1&pageSize=5`, { token: readToken }));
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.meta as { page: number }).page).toBe(1);
    const rows = body.data as Array<{ id: string; writable: boolean }>;
    expect(rows.some((r) => r.id === createdId)).toBe(true);
    // 本租户任务可写；跨租户任务只读（visible, writable=false）
    const own = rows.find((r) => r.id === createdId);
    expect(own?.writable).toBe(true);
  });

  it("?mine=true filters to caller tenant, all writable", async () => {
    const res = await listGET(req(`${BASE}/tasks?mine=true&pageSize=20`, { token: readToken }));
    expect(res.status).toBe(200);
    const rows = (await json(res)).data as Array<{ writable: boolean }>;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.writable === true)).toBe(true);
  });

  it("?owner=token filters to tasks created by the calling token", async () => {
    const res = await listGET(req(`${BASE}/tasks?owner=token&pageSize=20`, { token: writeToken }));
    expect(res.status).toBe(200);
    const rows = (await json(res)).data as Array<{ id: string }>;
    // writeToken 刚创建 contract-task，owner 过滤应能命中
    expect(rows.some((r) => r.id === createdId)).toBe(true);
  });

  it("?owner=token excludes tasks created by other tokens", async () => {
    const res = await listGET(req(`${BASE}/tasks?owner=token&pageSize=20`, { token: readToken }));
    expect(res.status).toBe(200);
    const rows = (await json(res)).data as Array<{ id: string }>;
    // readToken 未创建过任务 → contract-task 不应出现在它的 owner 视图中
    expect(rows.some((r) => r.id === createdId)).toBe(false);
  });

  it("anonymous ?owner=token is ignored (full read-only list)", async () => {
    const res = await listGET(req(`${BASE}/tasks?owner=token&pageSize=20`));
    expect(res.status).toBe(200);
    const rows = (await json(res)).data as Array<{ id: string; writable: boolean }>;
    expect(rows.some((r) => r.id === createdId)).toBe(true);
    expect(rows.every((r) => r.writable === false)).toBe(true);
  });

  it("anonymous list marks every task writable=false", async () => {
    const res = await listGET(req(`${BASE}/tasks?pageSize=20`));
    expect(res.status).toBe(200);
    const rows = (await json(res)).data as Array<{ writable: boolean }>;
    expect(rows.every((r) => r.writable === false)).toBe(true);
  });

  it("GET item returns the task", async () => {
    const res = await itemGET(req(`${BASE}/tasks/${createdId}`, { token: readToken }), {
      params: Promise.resolve({ id: createdId }),
    });
    expect(res.status).toBe(200);
  });

  it("GET item without a token → 200 (anonymous detail read)", async () => {
    const res = await itemGET(req(`${BASE}/tasks/${createdId}`), {
      params: Promise.resolve({ id: createdId }),
    });
    expect(res.status).toBe(200);
  });

  it("PATCH with a wrong version → 409 VERSION_CONFLICT", async () => {
    const res = await PATCH(
      req(`${BASE}/tasks/${createdId}`, {
        method: "PATCH",
        body: { name: "stale-edit", version: 999999 },
        token: writeToken,
      }),
      { params: Promise.resolve({ id: createdId }) },
    );
    expect(res.status).toBe(409);
    const body = await json(res);
    expect((body.error as { code: string }).code).toBe("VERSION_CONFLICT");
  });

  it("PATCH with current version → 200 and version++", async () => {
    // 重新读取当前 version，避免依赖前面的副作用
    const current = await itemGET(req(`${BASE}/tasks/${createdId}`, { token: readToken }), {
      params: Promise.resolve({ id: createdId }),
    });
    const currentBody = await json(current);
    const currentVersion = ((currentBody.data as { version: number }).version ?? 1) as number;

    const res = await PATCH(
      req(`${BASE}/tasks/${createdId}`, {
        method: "PATCH",
        body: { name: "renamed", version: currentVersion },
        token: writeToken,
      }),
      { params: Promise.resolve({ id: createdId }) },
    );
    expect(res.status).toBe(200);
    const body = await json(res);
    expect((body.data as { name: string }).name).toBe("renamed");
    expect((body.data as { version: number }).version).toBe(currentVersion + 1);
  });

  it("run-now → 202 with executionId", async () => {
    const res = await runNowPOST(
      req(`${BASE}/tasks/${createdId}/run-now`, { method: "POST", token: writeToken }),
      { params: Promise.resolve({ id: createdId }) },
    );
    expect(res.status).toBe(202);
    const body = await json(res);
    expect((body.data as { executionId: string }).executionId).toBeTruthy();
  });

  it("GET unknown id → 404", async () => {
    const res = await itemGET(req(`${BASE}/tasks/nope`, { token: readToken }), {
      params: Promise.resolve({ id: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("DELETE → 204", async () => {
    const temp = await POST(
      req(`${BASE}/tasks`, {
        method: "POST",
        body: {
          name: "delete-me",
          cron: "30 * * * *",
          taskType: "noop",
          payload: {},
          recipients: ["ops@example.com"],
        },
        token: writeToken,
      }),
    );
    const tempBody = await json(temp);
    const id = (tempBody.data as { id: string }).id;
    const res = await DELETE(req(`${BASE}/tasks/${id}`, { method: "DELETE", token: writeToken }), {
      params: Promise.resolve({ id }),
    });
    expect(res.status).toBe(204);
    const after = await itemGET(req(`${BASE}/tasks/${id}`, { token: readToken }), {
      params: Promise.resolve({ id }),
    });
    expect(after.status).toBe(404);
  });
});
