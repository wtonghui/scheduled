import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/db";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import { redriveEmail, redriveWebhook } from "../../src/modules/notification/repository";
import * as taskService from "../../src/modules/task/service";
import { runEmailRelayOnce } from "../../worker/relay";
import { runWebhookRelayOnce } from "../../worker/webhook-relay";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/**
 * P1-2 死信重投：dead → redrive → pending → 中继 → sent；
 * 跨租户 404、非 dead 行 409、非法 id 400。
 */

let server: http.Server;
let baseUrl: string;
let hookHits = 0;

function startServer(): Promise<string> {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url === "/ok") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (req.url === "/hook-ok") {
        req.resume();
        req.on("end", () => {
          hookHits += 1;
          res.writeHead(200);
          res.end("ok");
        });
        return;
      }
      if (req.url === "/hook-500") {
        res.writeHead(500);
        res.end("boom");
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
  const row = await prisma.task.findUniqueOrThrow({ where: { id: taskId } });
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

async function waitFor(
  check: () => Promise<boolean>,
  rounds = 25,
): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    if (await check()) {
      return;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  expect(await check()).toBe(true);
}

describe("outbox redrive", () => {
  let tenantId: string;
  let tokenId: string;
  let otherTenantId: string;

  beforeAll(async () => {
    registerDefaultExecutors();
    baseUrl = await startServer();
    const tenant = await createTestTenant("outbox-redrive");
    tenantId = tenant.id;
    tokenId = (await createTestToken(tenant.id, ["tasks:read", "tasks:write"], "owner")).id;
    otherTenantId = (await createTestTenant("outbox-redrive-other")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
    await cleanupTenant(otherTenantId);
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  });

  it("webhook dead → redrive → sent（下游恢复后复活）", async () => {
    hookHits = 0;
    const task = await taskService.create(tenantId, tokenId, {
      name: "redrive-webhook-proof",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: { url: `${baseUrl}/ok`, method: "GET" },
      recipients: ["ops@example.com"],
      webhookUrl: `${baseUrl}/hook-500`,
    });
    const outcome = await runTaskWithScheduledAt(await loadTaskDef(task.id), new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    // 一次打满进 dead（maxAttempts=1，下游恒 500）
    await prisma.webhookDelivery.update({
      where: { runId: outcome.executionId },
      data: { maxAttempts: 1 },
    });
    await runWebhookRelayOnce(20);
    expect(
      (await prisma.webhookDelivery.findUnique({ where: { runId: outcome.executionId } }))?.status,
    ).toBe("dead");

    // 跨租户一律 404
    await expect(redriveWebhook("1", otherTenantId, tokenId)).rejects.toMatchObject({
      status: 404,
    });

    // 重投：回到 pending、次数归零
    const row = await prisma.webhookDelivery.findUniqueOrThrow({
      where: { runId: outcome.executionId },
    });
    const redriven = await redriveWebhook(String(row.id), tenantId, tokenId);
    expect(redriven.status).toBe("pending");
    expect(redriven.attempts).toBe(0);

    // 非 dead 行再点 → 409
    await expect(redriveWebhook(String(row.id), tenantId, tokenId)).rejects.toMatchObject({
      status: 409,
    });

    // 下游恢复（换 healthy 地址模拟）→ 下轮中继投出 sent
    await prisma.webhookDelivery.update({
      where: { runId: outcome.executionId },
      data: { webhookUrl: `${baseUrl}/hook-ok` },
    });
    await waitFor(async () => {
      await runWebhookRelayOnce(20);
      const cur = await prisma.webhookDelivery.findUnique({
        where: { runId: outcome.executionId },
      });
      return cur?.status === "sent";
    });
    expect(hookHits).toBe(1);
  });

  it("email dead → redrive → sent", async () => {
    const task = await taskService.create(tenantId, tokenId, {
      name: "redrive-email-proof",
      cron: "*/5 * * * *",
      taskType: "noop",
      payload: {},
      recipients: ["ops@example.com"],
    });
    const outcome = await runTaskWithScheduledAt(await loadTaskDef(task.id), new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    const email = await prisma.emailLog.findUniqueOrThrow({ where: { runId: outcome.executionId } });
    // 直接置 dead（json provider 恒成功，走真实打满太慢；redrive 只认状态）
    await prisma.emailLog.update({
      where: { runId: outcome.executionId },
      data: { status: "dead", attempts: 5 },
    });

    const redriven = await redriveEmail(String(email.id), tenantId, tokenId);
    expect(redriven.status).toBe("pending");
    expect(redriven.attempts).toBe(0);

    await waitFor(async () => {
      await runEmailRelayOnce(20);
      const cur = await prisma.emailLog.findUnique({ where: { id: email.id } });
      return cur?.status === "sent";
    });
  });

  it("非法 id → 400；跨租户 email → 404", async () => {
    await expect(redriveEmail("abc", tenantId, tokenId)).rejects.toMatchObject({ status: 400 });
    await expect(redriveWebhook("12x", tenantId, tokenId)).rejects.toMatchObject({ status: 400 });
    await expect(redriveEmail("1", otherTenantId, tokenId)).rejects.toMatchObject({ status: 404 });
  });
});
