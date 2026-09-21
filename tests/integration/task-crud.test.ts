import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../../src/lib/errors";
import * as taskService from "../../src/modules/task/service";
import { cleanupTenant, createTestTask, createTestTenant, createTestToken } from "./helpers";

/**
 * US1 集成测试（T017）：CRUD 全持久化、乐观并发 409、多租户隔离 404。
 */

describe("task service CRUD (integration)", () => {
  let tenantA: string;
  let tenantB: string;
  let ownerTokenA: string;
  let taskId: string;

  beforeAll(async () => {
    const a = await createTestTenant("us1-a");
    const b = await createTestTenant("us1-b");
    tenantA = a.id;
    tenantB = b.id;
    ownerTokenA = (await createTestToken(a.id, ["tasks:read", "tasks:write"], "owner-a")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantA);
    await cleanupTenant(tenantB);
  });

  it("creates an http task with encrypted secrets and computed next_run_at", async () => {
    const view = await taskService.create(tenantA, ownerTokenA, {
      name: "heartbeat",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: {
        url: "https://example.com/health",
        method: "GET",
        headers: { authorization: "Bearer sekrit" },
      },
      recipients: ["ops@example.com"],
    });

    taskId = view.id;
    expect(view.enabled).toBe(true);
    expect(view.taskType).toBe("http");
    expect(view.payload).toMatchObject({
      url: "https://example.com/health",
      headers: { authorization: "Bearer sekrit" },
    });
    expect(view.nextRunAt).toBeInstanceOf(Date);
    expect((view.nextRunAt as Date).getTime()).toBeGreaterThan(Date.now());
    expect(view.version).toBe(1);
  });

  it("lists tasks with pagination meta", async () => {
    const { data, meta } = await taskService.list(tenantA, { page: 1, pageSize: 10 });
    expect(meta).toEqual({ page: 1, pageSize: 10, total: 1 });
    expect(data.some((t) => t.id === taskId)).toBe(true);
  });

  it("gets a task by id", async () => {
    const view = await taskService.get(tenantA, taskId);
    expect(view.id).toBe(taskId);
  });

  it("disables a task → next_run_at null", async () => {
    const view = await taskService.update(tenantA, taskId, { enabled: false, version: 1 });
    expect(view.enabled).toBe(false);
    expect(view.nextRunAt).toBeNull();
    expect(view.version).toBe(2);
  });

  it("updating cron persists the new schedule (not only next_run_at)", async () => {
    const view = await taskService.update(tenantA, taskId, {
      cron: "*/10 * * * *",
      scheduleIntervalSeconds: null,
      enabled: true,
      version: 2,
    });
    expect(view.cron).toBe("*/10 * * * *");
    expect(view.scheduleIntervalSeconds).toBeNull();
    expect(view.nextRunAt).not.toBeNull();
    expect(view.version).toBe(3);

    // 重新读取仍应能拿到新 cron（此前该字段在 update 时被漏写）
    const reloaded = await taskService.get(tenantA, taskId);
    expect(reloaded.cron).toBe("*/10 * * * *");
  });

  it("updating with a stale version → 409 VERSION_CONFLICT", async () => {
    await expect(
      taskService.update(tenantA, taskId, { name: "winner", version: 1 }),
    ).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("cross-tenant access → 404 NOT_FOUND", async () => {
    await expect(taskService.get(tenantB, taskId)).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });

  it("invalid cron → 400 VALIDATION", async () => {
    await expect(
      taskService.create(tenantA, ownerTokenA, {
        name: "bad",
        cron: "not-a-cron",
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("ssrf-rejected url (unsupported protocol) → 400 VALIDATION", async () => {
    await expect(
      taskService.create(tenantA, ownerTokenA, {
        name: "ssrf",
        cron: "* * * * *",
        taskType: "http",
        payload: { url: "ftp://example.com/health" },
        recipients: ["ops@example.com"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });
  });

  it("recipients is optional: omitted → [], explicit [] ok, bad email → 400", async () => {
    const noKey = await taskService.create(tenantA, ownerTokenA, {
      name: "no-recipients-key",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
    });
    expect(noKey.recipients).toEqual([]);

    const empty = await taskService.create(tenantA, ownerTokenA, {
      name: "empty-recipients",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
      recipients: [],
    });
    expect(empty.recipients).toEqual([]);

    await expect(
      taskService.create(tenantA, ownerTokenA, {
        name: "bad-recipient",
        cron: "*/5 * * * *",
        taskType: "noop",
        payload: {},
        recipients: ["not-an-email"],
      }),
    ).rejects.toMatchObject({ code: "VALIDATION", status: 400 });

    // 更新清空收件人同样放行
    const cleared = await taskService.update(tenantA, taskId, {
      recipients: [],
      version: 3,
    });
    expect(cleared.recipients).toEqual([]);
  });

  it("run-now creates a pending execution", async () => {
    const execution = await taskService.runTaskNow(tenantA, taskId);
    expect(execution.trigger).toBe("manual");
    expect(execution.status).toBe("pending");
    expect(execution.attempt).toBe(1);
  });

  it("deletes a task (idempotent 404 after)", async () => {
    const temp = await createTestTask(tenantA, { name: "to-delete" });
    await taskService.remove(tenantA, temp.id);
    await expect(taskService.get(tenantA, temp.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("throws AppError for unknown task", async () => {
    await expect(taskService.get(tenantA, "does-not-exist")).rejects.toBeInstanceOf(AppError);
  });
});
