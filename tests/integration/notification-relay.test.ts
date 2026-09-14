import http from "node:http";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { prisma } from "../../src/lib/db";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import * as taskService from "../../src/modules/task/service";
import { runEmailRelayOnce } from "../../worker/relay";
import { runWebhookRelayOnce } from "../../worker/webhook-relay";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * 通知组必做5：三条集成证明（生产级证据）。
 * 1. failed→到时→sent：第一次 500 进 failed，推前 nextRetryAt 后重投 sent。
 * 2. 重定向到 localhost 被逐跳 SSRF 拦截：302 到 localhost 不跟随，直接 dead，目标零命中。
 * 3. 坏模板不断联：未知占位模板仍入队可投递（原文保留）。
 */

let server: http.Server;
let baseUrl: string;
let hookHits: string[] = [];
let flakyFailNext = false;
let redirectTargetHits = 0;

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
          hookHits.push(body);
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }
      if (req.url === "/hook-flaky") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          if (flakyFailNext) {
            flakyFailNext = false;
            res.writeHead(500);
            res.end("boom");
            return;
          }
          hookHits.push(body);
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }
      if (req.url === "/hook-redirect") {
        // 恒禁主机名（任何 SSRF_ALLOW_* 组合下均拦截）：验证逐跳复核
        res.writeHead(302, { location: `http://metadata.google.internal/hook` });
        res.end();
        return;
      }
      if (req.url === "/hook-target") {
        redirectTargetHits += 1;
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

/**
 * 中继无租户过滤，并行跑多文件时会互相认领对方的行（属既有设计）。
 * 本文件断言一律轮询本行终态（带跑一轮中继），不依赖全局计数，避免跨文件串扰。
 */
async function waitForWebhook(runId: string, want: string, rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await runWebhookRelayOnce(20);
    const row = await prisma.webhookDelivery.findUnique({ where: { runId } });
    if (row?.status === want) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const row = await prisma.webhookDelivery.findUnique({ where: { runId } });
  expect(row?.status).toBe(want);
}

async function waitForEmail(id: bigint, want: string, rounds = 25): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await runEmailRelayOnce(20);
    const row = await prisma.emailLog.findUnique({ where: { id } });
    if (row?.status === want) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  const row = await prisma.emailLog.findUnique({ where: { id } });
  expect(row?.status).toBe(want);
}

describe("notification relay proofs", () => {
  let tenantId: string;
  let ownerTokenId: string;

  beforeAll(async () => {
    registerDefaultExecutors();
    baseUrl = await startServer();
    const tenant = await createTestTenant("notification-relay");
    tenantId = tenant.id;
    ownerTokenId = (await createTestToken(tenant.id, ["tasks:read", "tasks:write"], "owner")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("failed→retry→sent：500 先进 failed，到时重投 sent", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    flakyFailNext = true;
    hookHits = [];
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "relay-retry-proof",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      webhookUrl: `${baseUrl}/hook-flaky`,
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    // 第一轮：flaky 500 → failed（可重试），非 dead（只断言本行终态，全局计数会被同租户遗留行干扰）
    await runWebhookRelayOnce(20);
    const failed = await prisma.webhookDelivery.findUnique({
      where: { runId: outcome.executionId },
    });
    expect(failed?.status).toBe("failed");
    expect(hookHits).toHaveLength(0);

    // 推前重试时刻 → 第二轮投递成功
    await prisma.webhookDelivery.update({
      where: { runId: outcome.executionId },
      data: { nextRetryAt: new Date(Date.now() - 1000) },
    });
    await runWebhookRelayOnce(20);
    expect(
      (await prisma.webhookDelivery.findUnique({ where: { runId: outcome.executionId } }))?.status,
    ).toBe("sent");
    expect(hookHits).toHaveLength(1);
    vi.restoreAllMocks();
  });

  it("重定向到元数据主机被逐跳拦截：302 不跟随，目标零命中，直接 dead", async () => {
    hookHits = [];
    redirectTargetHits = 0;
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "relay-redirect-proof",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      webhookUrl: `${baseUrl}/hook-redirect`,
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    // 只断言本行终态（全局计数会被同文件遗留行干扰）
    await runWebhookRelayOnce(20);
    const row = await prisma.webhookDelivery.findUnique({
      where: { runId: outcome.executionId },
    });
    expect(row?.status).toBe("dead");
    expect(row?.lastError ?? "").toMatch(/ssrf|blocked|localhost/i);
    expect(hookHits).toHaveLength(0);
    expect(redirectTargetHits).toBe(0);
  });

  it("坏模板不断联：未知占位仍入队可投递", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "relay-template-proof",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      emailBodyTemplate: "{notExist.deep} hello",
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    const emails = await prisma.emailLog.findMany({ where: { taskId: task.id } });
    expect(emails).toHaveLength(1);
    // 只断言本行终态（全局计数会被同文件遗留行干扰）
    await runEmailRelayOnce(20);
    expect((await prisma.emailLog.findUnique({ where: { id: emails[0]!.id } }))?.status).toBe(
      "sent",
    );
  });
});
