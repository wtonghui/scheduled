import http from "node:http";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptSecret } from "../../src/lib/crypto";
import { prisma } from "../../src/lib/db";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import * as taskService from "../../src/modules/task/service";
import { verifyWebhook } from "../../src/modules/webhook/signature";
import { runEmailRelayOnce } from "../../worker/relay";
import { runWebhookRelayOnce } from "../../worker/webhook-relay";
import { cleanupTenant, createTestTask, createTestTenant, createTestToken } from "./helpers";

/**
 * US3 集成测试（T030）：邮件幂等、Webhook HMAC 签名+验签、outbox、中继幂等。
 * 需要 SSRF_ALLOW_PRIVATE（本地测试服务器）+ MAIL_PROVIDER=json。
 */

let server: http.Server;
let baseUrl: string;
let webhookHits: Array<{ body: string; signature: string | undefined }> = [];
let failFirst = false;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/hook") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          webhookHits.push({
            body,
            signature: req.headers["x-scheduled-signature"] as string | undefined,
          });
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }
      if (req.url === "/flaky") {
        if (failFirst) {
          failFirst = false;
          res.writeHead(500);
          res.end("nope");
          return;
        }
        res.writeHead(200);
        res.end("ok");
        return;
      }
      res.writeHead(404);
      res.end();
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`);
    });
  });
}

async function loadTaskDef(taskId: string) {
  const row = await prisma.task.findUnique({ where: { id: taskId } });
  if (!row) {
    throw new Error("task not found");
  }
  return {
    id: row.id,
    taskType: row.taskType,
    payload: (row.payload ?? {}) as Record<string, unknown>,
    payloadSecrets: row.payloadSecrets ? new Uint8Array(row.payloadSecrets) : null,
    timeoutMs: row.timeoutMs,
    maxAttempts: row.maxAttempts,
    tenantId: row.tenantId,
    taskName: row.name,
    recipients: (row.recipients as string[]) ?? [],
    notifyOn: (row.notifyOn as string[]) ?? [],
    webhookUrl: row.webhookUrl,
    webhookSecret: row.webhookSecret ? new Uint8Array(row.webhookSecret) : null,
  };
}

describe("notification outbox + relays", () => {
  let tenantId: string;
  let ownerTokenId: string;

  beforeAll(async () => {
    registerDefaultExecutors();
    baseUrl = await startServer();
    const tenant = await createTestTenant("notification");
    tenantId = tenant.id;
    ownerTokenId = (await createTestToken(tenant.id, ["tasks:read", "tasks:write"], "owner")).id;
  });

  afterEach(() => {
    webhookHits = [];
    failFirst = false;
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("success run → exactly one email + one webhook, HMAC verifies, relay idempotent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-ok",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      webhookUrl: `${baseUrl}/hook`,
    });

    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    const emails = await prisma.emailLog.findMany({ where: { taskId: task.id } });
    const hooks = await prisma.webhookDelivery.findMany({ where: { runId: outcome.executionId } });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain("执行成功");
    expect(emails[0]!.html).toBeTruthy();
    expect(emails[0]!.text).toBeTruthy();
    expect(hooks).toHaveLength(1);

    const deliveredEmail = await runEmailRelayOnce(20);
    const deliveredHook = await runWebhookRelayOnce(20);
    expect(deliveredEmail).toBe(1);
    expect(deliveredHook).toBe(1);

    const email = await prisma.emailLog.findUnique({ where: { id: emails[0]!.id } });
    expect(email?.status).toBe("sent");
    const hook = await prisma.webhookDelivery.findUnique({ where: { id: hooks[0]!.id } });
    expect(hook?.status).toBe("sent");
    expect(hook?.responseCode).toBe(200);

    const secret = def.webhookSecret ? decryptSecret(new Uint8Array(def.webhookSecret)) : "";
    expect(webhookHits).toHaveLength(1);
    const verdict = verifyWebhook(webhookHits[0]!.body, webhookHits[0]!.signature, secret);
    expect(verdict.valid).toBe(true);
    const payload = JSON.parse(webhookHits[0]!.body) as { status: string; runId: string };
    expect(payload.status).toBe("succeeded");
    expect(payload.runId).toBe(outcome.executionId);

    // 幂等：再次跑中继 → 0 新投递
    expect(await runEmailRelayOnce(20)).toBe(0);
    expect(await runWebhookRelayOnce(20)).toBe(0);
    expect(webhookHits).toHaveLength(1);
  });

  it("notifyOn=[failed] → 成功运行零通知；失败运行邮件+webhook 均入 outbox", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-gated",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      notifyOn: ["failed"],
      webhookUrl: `${baseUrl}/hook`,
    });

    const def = await loadTaskDef(task.id);

    // 成功：notifyOn 只订阅 failed → 邮件与 webhook 都不应产生
    const okRun = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(okRun.status).toBe("succeeded");
    expect(await prisma.emailLog.count({ where: { runId: okRun.executionId } })).toBe(0);
    expect(await prisma.webhookDelivery.count({ where: { runId: okRun.executionId } })).toBe(0);

    // 失败（404 永久错误，单次即终态）：两类通知都应产生
    const failingDef = { ...def, payload: { ...def.payload, url: `${baseUrl}/missing` } };
    const badRun = await runTaskWithScheduledAt(failingDef, new Date(), "scheduled");
    expect(badRun.status).toBe("failed");
    expect(await prisma.emailLog.count({ where: { runId: badRun.executionId } })).toBe(1);
    expect(await prisma.webhookDelivery.count({ where: { runId: badRun.executionId } })).toBe(1);

    // 清场：把本用例的 outbox 投递到终态，避免残留 pending 行污染后续用例的全局中继计数
    await runEmailRelayOnce(20);
    await runWebhookRelayOnce(20);
  });

  it("retried run that succeeds → still exactly one email (run_id idempotent)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    failFirst = true;
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-retry",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/flaky`, method: "GET" },
      recipients: ["ops@example.com"],
      maxAttempts: 3,
    });

    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    const emails = await prisma.emailLog.findMany({ where: { taskId: task.id } });
    expect(emails).toHaveLength(1); // 只有最终成功一封

    await runEmailRelayOnce(20);
    const email = await prisma.emailLog.findUnique({ where: { id: emails[0]!.id } });
    expect(email?.status).toBe("sent");
  });

  it("permanent failure → one failure email (❌ subject)", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-fail",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/not-found`, method: "GET" },
      recipients: ["ops@example.com"],
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("failed");

    const emails = await prisma.emailLog.findMany({ where: { taskId: task.id } });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toContain("执行失败");
  });

  it("encrypted payload secrets flow through to execution requests", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "secret-headers",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: {
        url: `${baseUrl}/ok`,
        method: "GET",
        headers: { authorization: "Bearer top-secret" },
      },
      recipients: ["ops@example.com"],
    });
    // 落库的 payload 不应包含明文 header
    const raw = await prisma.task.findUnique({ where: { id: task.id } });
    expect(JSON.stringify(raw?.payload)).not.toContain("top-secret");
    expect(raw?.payloadSecrets).toBeTruthy();
    // view 解密合并后可见
    const view = await taskService.get(tenantId, task.id);
    expect((view.payload.headers as Record<string, string>).authorization).toBe(
      "Bearer top-secret",
    );
  });

  it("webhook delivery is self-contained (payload + secret snapshot survive task mutation)", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "hook-selfcontained",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok` },
      recipients: ["ops@example.com"],
      webhookUrl: `${baseUrl}/hook`,
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");

    // 篡改任务行（模拟任务后续被改/删除语义）——中继只依赖 webhook_delivery 快照
    await prisma.task.update({
      where: { id: task.id },
      data: { webhookUrl: null, name: "renamed-after-run" },
    });

    expect(await runWebhookRelayOnce(20)).toBe(1);
    const hook = await prisma.webhookDelivery.findUnique({
      where: { runId: outcome.executionId },
    });
    expect(hook?.status).toBe("sent");
    expect(hook?.webhookSecret).toBeTruthy(); // 密钥快照持久化

    // 任务删除（含历史执行）也应可成功
    await taskService.remove(tenantId, task.id);
    const leftover = await prisma.task.findUnique({ where: { id: task.id } });
    expect(leftover).toBeNull();
  });

  it("noop task doesn't need payload and succeeds", async () => {
    const task = await createTestTask(tenantId, { taskType: "noop" });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");
  });

  it("succeeded_with_results: http with data notifies mail + webhook", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-results-http",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      notifyOn: ["succeeded_with_results"],
      webhookUrl: `${baseUrl}/hook`,
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");
    // /ok 返回 {ok:true} → data 非空 → 邮件 + webhook 都入 outbox
    const emails = await prisma.emailLog.findMany({ where: { taskId: task.id } });
    expect(emails).toHaveLength(1);
    const hooks = await prisma.webhookDelivery.findMany({ where: { runId: outcome.executionId } });
    expect(hooks).toHaveLength(1);
    // 中继只断言本行终态（全局计数会被文件内其他用例遗留行干扰）
    await runWebhookRelayOnce(20);
    await runEmailRelayOnce(20);
    expect((await prisma.emailLog.findUnique({ where: { id: emails[0]!.id } }))?.status).toBe(
      "sent",
    );
    expect((await prisma.webhookDelivery.findUnique({ where: { id: hooks[0]!.id } }))?.status).toBe(
      "sent",
    );
  });

  it("succeeded_with_results: noop without data notifies neither", async () => {
    const created = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-results-noop",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
      notifyOn: ["succeeded_with_results"],
      webhookUrl: `${baseUrl}/hook`,
    });
    const def = await loadTaskDef(created.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");
    // noop 结果 {kind} 无 data → 邮件 webhook 都不入 outbox
    expect(await prisma.emailLog.findMany({ where: { taskId: created.id } })).toHaveLength(0);
    expect(
      await prisma.webhookDelivery.findMany({ where: { runId: outcome.executionId } }),
    ).toHaveLength(0);
  });

  it("stale in_progress relay rows are reclaimed and delivered", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-reclaim",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      webhookUrl: `${baseUrl}/hook`,
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");
    // 模拟认领后崩溃：in_progress + updatedAt 20 分钟前
    const staleAt = new Date(Date.now() - 20 * 60 * 1000);
    const email = await prisma.emailLog.findFirst({ where: { taskId: task.id } });
    await prisma.emailLog.update({
      where: { id: email!.id },
      data: { status: "in_progress", updatedAt: staleAt },
    });
    const hook = await prisma.webhookDelivery.findFirst({ where: { runId: outcome.executionId } });
    await prisma.webhookDelivery.update({
      where: { id: hook!.id },
      data: { status: "in_progress", updatedAt: staleAt },
    });
    // 回收重投（只断言本行终态，全局计数会被遗留行干扰）
    await runEmailRelayOnce(20);
    await runWebhookRelayOnce(20);
    expect((await prisma.emailLog.findUnique({ where: { id: email!.id } }))?.status).toBe("sent");
    expect((await prisma.webhookDelivery.findUnique({ where: { id: hook!.id } }))?.status).toBe(
      "sent",
    );
  });

  it("fresh in_progress relay rows are left alone", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "notify-fresh",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
    });
    const def = await loadTaskDef(task.id);
    await runTaskWithScheduledAt(def, new Date(), "scheduled");
    const email = await prisma.emailLog.findFirst({ where: { taskId: task.id } });
    // 刚认领（updatedAt 现在）→ 不回收；只断言本行仍为 in_progress（全局计数会被遗留行干扰）
    await prisma.emailLog.update({ where: { id: email!.id }, data: { status: "in_progress" } });
    await runEmailRelayOnce(20);
    expect((await prisma.emailLog.findUnique({ where: { id: email!.id } }))?.status).toBe(
      "in_progress",
    );
  });
});
