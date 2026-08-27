import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/db";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import { advanceMissedRuns, claimDueTasks } from "../../worker/scheduler";
import { cleanupTenant, createTestTask, createTestTenant, createTestToken } from "./helpers";

/**
 * US2 集成测试（T024）：领取幂等(SKIP LOCKED)、重试、超时、重启不补跑、重叠允许。
 * 本地 HTTP 测试服务器提供可控响应（需 SSRF_ALLOW_PRIVATE 测试开关）。
 */

let server: http.Server;
let baseUrl: string;
const requests: Array<{ url: string; headers: http.IncomingHttpHeaders }> = [];

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      requests.push({ url: req.url ?? "", headers: req.headers });
      if (req.url?.startsWith("/ok")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url?.startsWith("/text")) {
        res.writeHead(200, { "content-type": "text/plain" });
        res.end("pong");
        return;
      }
      if (req.url?.startsWith("/retry")) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "boom" }));
        return;
      }
      if (req.url?.startsWith("/not-found")) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "missing" }));
        return;
      }
      if (req.url?.startsWith("/slow")) {
        setTimeout(() => {
          res.writeHead(200);
          res.end("ok");
        }, 3000);
        return;
      }
      res.writeHead(418);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

describe("worker execution", () => {
  let tenantId: string;

  beforeAll(async () => {
    registerDefaultExecutors();
    baseUrl = await startServer();
    const tenant = await createTestTenant("worker-exec");
    tenantId = tenant.id;
    // createTestTask 兜底 owner 需要租户至少一个 token
    await createTestToken(tenant.id, ["tasks:read", "tasks:write"], "owner");
  });

  afterEach(() => {
    requests.length = 0;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  function taskFor(
    id: string,
    payload: Record<string, unknown>,
    overrides: Partial<NonNullable<Parameters<typeof runTaskWithScheduledAt>[0]>> = {},
  ) {
    return {
      id,
      taskType: "http" as const,
      payload,
      payloadSecrets: null,
      timeoutMs: 1000,
      maxAttempts: 1,
      tenantId: "test-tenant",
      taskName: "test-task",
      recipients: [],
      notifyOn: [],
      webhookUrl: null,
      webhookSecret: null,
      ...overrides,
    };
  }

  it("executes an http task to success (2xx)", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, { url: `${baseUrl}/ok` }),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("succeeded");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("/ok");
  });

  it("plain-text 2xx succeeds (non-JSON body must not fail the task)", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, { url: `${baseUrl}/text` }),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("succeeded");
  });

  it("http task merges payload.params into request query (keeps existing query)", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, {
        url: `${baseUrl}/ok?existing=1`,
        method: "GET",
        params: { page: "2", verbose: true, pageSize: 50 },
      }),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("succeeded");
    const hit = requests.find((r) => r.url.startsWith("/ok"));
    const u = new URL(hit!.url!, baseUrl);
    expect(u.searchParams.get("existing")).toBe("1"); // 原 url query 保留
    expect(u.searchParams.get("page")).toBe("2"); // params 字符串
    expect(u.searchParams.get("verbose")).toBe("true"); // boolean → "true"
    expect(u.searchParams.get("pageSize")).toBe("50"); // number → "50"
  });

  it("permanent 4xx → failed without retries", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, { url: `${baseUrl}/not-found` }),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("failed");
    expect(requests).toHaveLength(1);
  });

  it("retryable 5xx → dead after maxAttempts (one row per attempt)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0); // 0 延迟
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, { url: `${baseUrl}/retry` }, { maxAttempts: 3 }),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("dead");
    const rows = await prisma.taskExecution.findMany({
      where: { taskId: task.id },
      orderBy: { attempt: "asc" },
    });
    expect(rows.map((r) => r.attempt)).toEqual([1, 2, 3]);
    expect(rows.map((r) => r.status)).toEqual(["failed", "failed", "dead"]);
  });

  it("timeout counts as retryable and dead-letters on exhaustion", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, { url: `${baseUrl}/slow` }, { timeoutMs: 150, maxAttempts: 2 }),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("dead");
    const rows = await prisma.taskExecution.findMany({
      where: { taskId: task.id },
      orderBy: { attempt: "asc" },
    });
    expect(rows.map((r) => r.status)).toEqual(["timeout", "dead"]);
  });

  it("claim is idempotent: a second claim does not steal the task (SKIP LOCKED)", async () => {
    const task = await createTestTask(tenantId, {
      nextRunAt: new Date(Date.now() - 5_000),
    });
    const first = await claimDueTasks("worker-a", 60, 10, true);
    expect(first.some((c) => c.task.id === task.id)).toBe(true);

    const second = await claimDueTasks("worker-b", 60, 10, true);
    expect(second.some((c) => c.task.id === task.id)).toBe(false);

    const row = await prisma.task.findUnique({ where: { id: task.id } });
    expect(row?.claimedBy).toBe("worker-a");
    expect(row?.claimedUntil).not.toBeNull();
    // next_run_at 已推进（晚于原始到期时间，不补跑当前）
    expect(row?.nextRunAt?.getTime() ?? 0).toBeGreaterThan(task.nextRunAt?.getTime() ?? 0);
  });

  it("claim is idempotent without SKIP LOCKED (portable fallback for MySQL <8/ MariaDB <10.6)", async () => {
    // 强制走可移植路径（无 FOR UPDATE SKIP LOCKED，靠条件 UPDATE + affectedRows 判归属）
    const task = await createTestTask(tenantId, {
      nextRunAt: new Date(Date.now() - 5_000),
    });
    const first = await claimDueTasks("worker-b", 60, 10, false);
    expect(first.some((c) => c.task.id === task.id)).toBe(true);

    const second = await claimDueTasks("worker-a", 60, 10, false);
    expect(second.some((c) => c.task.id === task.id)).toBe(false);

    const row = await prisma.task.findUnique({ where: { id: task.id } });
    expect(row?.claimedBy).toBe("worker-b");
    expect(row?.claimedUntil).not.toBeNull();
    expect(row?.nextRunAt?.getTime() ?? 0).toBeGreaterThan(task.nextRunAt?.getTime() ?? 0);
  });

  it("restart catch-up advances missed runs without executing them", async () => {
    const task = await createTestTask(tenantId, {
      nextRunAt: new Date(Date.now() - 60_000),
      enabled: true,
      cron: "*/5 * * * *",
    });
    const before = await prisma.taskExecution.count({ where: { taskId: task.id } });
    const advanced = await advanceMissedRuns();
    expect(advanced).toBeGreaterThan(0);
    const after = await prisma.taskExecution.count({ where: { taskId: task.id } });
    expect(after).toBe(before); // 不执行，只推进
    const row = await prisma.task.findUnique({ where: { id: task.id } });
    expect(row?.nextRunAt ? row.nextRunAt.getTime() : 0).toBeGreaterThan(Date.now());
  });

  it("overlapping runs are allowed (same task twice concurrently)", async () => {
    const def = (id: string) => ({
      id,
      taskType: "noop" as const,
      payload: {},
      payloadSecrets: null,
      timeoutMs: 500,
      maxAttempts: 1,
    });
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const [a, b] = await Promise.all([
      runTaskWithScheduledAt(def(task.id), new Date(), "manual"),
      runTaskWithScheduledAt(def(task.id), new Date(), "manual"),
    ]);
    expect(a.status).toBe("succeeded");
    expect(b.status).toBe("succeeded");
  });
});
