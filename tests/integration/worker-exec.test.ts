import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { config } from "../../src/lib/config";
import { prisma } from "../../src/lib/db";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import { verifyWebhook } from "../../src/modules/webhook/signature";
import { createRunner } from "../../worker/runner";
import {
  advanceMissedRuns,
  claimDueTasks,
  reconcileOrphanExecutions,
  renewTaskLeases,
} from "../../worker/scheduler";
import { cleanupTenant, createTestTask, createTestTenant, createTestToken } from "./helpers";

/**
 * US2 集成测试（T024）：领取幂等(SKIP LOCKED)、重试、超时、重启不补跑、重叠允许。
 * 本地 HTTP 测试服务器提供可控响应（需 SSRF_ALLOW_PRIVATE 测试开关）。
 */

let server: http.Server;
let baseUrl: string;
const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      let rawBody = "";
      req.on("data", (c) => {
        rawBody += c;
      });
      req.on("end", () => {
        requests.push({ url: req.url ?? "", headers: req.headers, body: rawBody });
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
        if (req.url?.startsWith("/sse")) {
          // text/event-stream：分多个 chunk 逐步推送（模拟 LLM agent 流式输出）
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write('data: {"step":1}\n\n');
          setTimeout(() => res.write('data: {"step":2}\n\n'), 10);
          setTimeout(() => res.end("data: [DONE]\n\n"), 20);
          return;
        }
        res.writeHead(418);
        res.end();
      });
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
    const u = new URL(hit?.url ?? "", baseUrl);
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

  it("streaming (SSE) task succeeds and enqueues the email only after the stream is fully consumed", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(
        task.id,
        { url: `${baseUrl}/sse` },
        { tenantId, recipients: ["e2e-stream@example.com"], notifyOn: ["succeeded"] },
      ),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("succeeded");
    // 流完整消费完毕后终态才写入 → email outbox 随之落单（run_id 关联执行）
    const email = await prisma.emailLog.findFirst({ where: { runId: outcome.executionId } });
    expect(email).not.toBeNull();
    expect(email?.status).toBe("pending");
  });

  it("runner.submit returns immediately while a long task still runs (scheduler decoupled)", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const r = createRunner(2);
    const started = Date.now();
    r.submit([
      {
        kind: "scheduled",
        task: taskFor(task.id, { url: `${baseUrl}/slow` }, { timeoutMs: 5000, maxAttempts: 1 }),
        scheduledAt: new Date(),
      },
    ]);
    expect(Date.now() - started).toBeLessThan(500); // 只入池，不等完成
    expect(r.inFlightCount).toBe(1);
    await r.drain(6000);
    expect(r.inFlightCount).toBe(0);
  }, 15000);

  it("freeSlots reflects pool occupancy (claim bounded by capacity)", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const r = createRunner(1);
    expect(r.freeSlots).toBe(1);
    r.submit([
      {
        kind: "scheduled",
        task: taskFor(task.id, { url: `${baseUrl}/slow` }, { timeoutMs: 5000, maxAttempts: 1 }),
        scheduledAt: new Date(),
      },
    ]);
    expect(r.freeSlots).toBe(0);
    await r.drain(6000);
    expect(r.freeSlots).toBe(1);
  }, 15000);

  it("renews lease for long-running tasks so another instance cannot re-claim", async () => {
    const task = await createTestTask(tenantId, { nextRunAt: new Date(Date.now() - 5000) });
    const claimed = await claimDueTasks("wk-lease", 1, 10, true);
    expect(claimed.some((c) => c.task.id === task.id)).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // 1s 租约已过期
    const renewed = await renewTaskLeases([task.id], "wk-lease", 60);
    expect(renewed).toBe(1);
    const row = await prisma.task.findUnique({ where: { id: task.id } });
    expect(row?.claimedUntil?.getTime() ?? 0).toBeGreaterThan(Date.now());
  }, 10000);

  it("re-claims stale scheduled pending executions after restart (补跑, not double-run fresh ones)", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const exec = await prisma.taskExecution.create({
      data: {
        taskId: task.id,
        idempotencyKey: `${task.id}:restart:a1`,
        scheduledAt: new Date(Date.now() - 60_000),
        attempt: 1,
        trigger: "scheduled",
        status: "pending",
      },
    });
    // 回拨 created_at 越过补跑宽限期（模拟死 worker 遗留的 pending）
    await prisma.$executeRaw`UPDATE task_execution SET created_at = DATE_SUB(NOW(), INTERVAL 60 SECOND) WHERE id = ${exec.id}`;
    const claimed = await claimDueTasks("wk-bu", 60, 10, true);
    const hit = claimed.find((c) => c.kind === "manual" && c.executionId === exec.id);
    expect(hit).toBeDefined();
  });

  it("reconciles orphaned running executions whose task lease expired (no re-run)", async () => {
    const task = await createTestTask(tenantId, { nextRunAt: new Date(Date.now() - 5000) });
    const exec = await prisma.taskExecution.create({
      data: {
        taskId: task.id,
        idempotencyKey: `${task.id}:orphan:a1`,
        scheduledAt: new Date(Date.now() - 60_000),
        attempt: 1,
        trigger: "scheduled",
        status: "running",
        startedAt: new Date(Date.now() - 120_000),
      },
    });
    // 模拟死 worker：task 租约早已过期
    await prisma.task.update({
      where: { id: task.id },
      data: { claimedBy: "dead-worker", claimedUntil: new Date(Date.now() - 30_000) },
    });
    const handled = await reconcileOrphanExecutions();
    expect(handled).toBeGreaterThanOrEqual(1);
    const row = await prisma.taskExecution.findUnique({ where: { id: exec.id } });
    expect(row?.status).toBe("failed");
    const taskAfter = await prisma.task.findUnique({ where: { id: task.id } });
    expect(taskAfter?.claimedBy).toBeNull();
    expect(taskAfter?.claimedUntil).toBeNull();
  });

  it("signs task callback headers (scheduled → trigger 1, runId matches)", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, { url: `${baseUrl}/ok`, method: "POST", body: '{"a":1}' }),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("succeeded");
    expect(requests).toHaveLength(1);
    const hit = requests[0]!;
    const headers = hit.headers;
    expect(headers["x-scheduled-signature"]).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(headers["x-execution-id"]).toBe(outcome.executionId);
    expect(headers["x-trigger-type"]).toBe("1");
    // 对方口径验签：t.body 用实际收到的精确字节（含 POST body）
    const verdict = verifyWebhook(
      hit.body,
      headers["x-scheduled-signature"] as string,
      config.TASK_CALLBACK_SIGN_SECRET as string,
    );
    expect(verdict.valid).toBe(true);
  });

  it("manual run-now signs trigger 2 and platform headers override user headers", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const exec = await prisma.taskExecution.create({
      data: {
        taskId: task.id,
        idempotencyKey: `${task.id}:manual-sign:a1`,
        scheduledAt: new Date(),
        attempt: 1,
        trigger: "manual",
        status: "pending",
      },
    });
    const outcome = await runTaskWithScheduledAt(
      taskFor(task.id, {
        url: `${baseUrl}/ok`,
        headers: { "X-Execution-Id": "fake", "X-Trigger-Type": "9" },
      }),
      new Date(),
      "manual",
      { executionId: exec.id },
    );
    expect(outcome.status).toBe("succeeded");
    const headers = requests[0]!.headers;
    expect(headers["x-trigger-type"]).toBe("2");
    expect(headers["x-execution-id"]).toBe(outcome.executionId);
    expect(headers["x-execution-id"]).not.toBe("fake");
  });

  it("retry attempt signs trigger 3", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const outcome = await runTaskWithScheduledAt(
      taskFor(
        task.id,
        { url: `${baseUrl}/retry` },
        { maxAttempts: 2, retryDelayMs: 0, timeoutMs: 1000 },
      ),
      new Date(),
      "scheduled",
    );
    expect(outcome.status).toBe("dead");
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers["x-trigger-type"]).toBe("1");
    expect(requests[1]!.headers["x-trigger-type"]).toBe("3");
  });
});
