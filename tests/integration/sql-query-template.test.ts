import http from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "../../src/lib/db";
import { runTaskWithScheduledAt } from "../../src/modules/execution/service";
import { registerDefaultExecutors } from "../../src/modules/execution/register";
import * as taskService from "../../src/modules/task/service";
import { cleanupTenant, createTestTenant, createTestToken } from "./helpers";

/** 上游冻结包体：成功 code:200 / 失败 code:0（HTTP 恒 200）。 */
const SUCCESS_BODY = {
  code: 200,
  msg: "成功",
  data: {
    executionId: "1889012345678901234",
    rowCount: 1286,
    fileUrl: "https://minio.example.com/scheduled-task/xxx/result.xlsx",
    fileSize: 1887436,
    fileType: "xlsx",
    fileName: "文件名",
    taskName: "任务名",
    executionAt: "2026-09-18 11:11:00",
    previewRowCount: 500,
    previewFileds: JSON.stringify([
      "id",
      "name",
    ]),
    previewContent: JSON.stringify([
      { id: 1, name: "张三" },
      { id: 2, name: "李四" },
    ]),
    viewUrl: "http://www.xxx.com/yyy/zzz",
  },
};
const FAIL_BODY = {
  code: 0,
  msg: "SQL 执行超时",
  data: {
    executionId: "1889012345678901234",
    taskName: "任务名",
    executionAt: "2026-09-18 11:11:00",
    viewUrl: "http://www.xxx.com/yyy/zzz",
  },
};

let server: http.Server;
let baseUrl = "";
let tenantId = "";
let ownerTokenId = "";

async function loadTaskDef(taskId: string) {
  const row = await prisma.task.findUnique({ where: { id: taskId } });
  if (!row) throw new Error("task not found");
  return {
    id: row.id,
    taskType: row.taskType as "http",
    payload: (row.payload ?? {}) as Record<string, unknown>,
    payloadSecrets: null,
    timeoutMs: row.timeoutMs,
    maxAttempts: 1,
    tenantId: row.tenantId,
    taskName: row.name,
    recipients: (row.recipients as string[]) ?? [],
    notifyOn: (row.notifyOn as string[]) ?? [],
    webhookUrl: null,
    webhookSecret: null,
    emailSubjectTemplate: row.emailSubjectTemplate,
    emailBodyTemplate: row.emailBodyTemplate,
    emailSubjectTemplateFailed: row.emailSubjectTemplateFailed,
    emailBodyTemplateFailed: row.emailBodyTemplateFailed,
    emailAttachmentUrlTemplate: row.emailAttachmentUrlTemplate,
  };
}

describe("SQL 定时查询邮件模板端到端", () => {
  beforeAll(async () => {
    registerDefaultExecutors();
    server = http.createServer((req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(req.url?.startsWith("/sql-fail") ? FAIL_BODY : SUCCESS_BODY));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
    const address = server.address();
    baseUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    const tenant = await createTestTenant("sql-template");
    tenantId = tenant.id;
    ownerTokenId = (await createTestToken(tenant.id, ["tasks:read", "tasks:write"], "owner")).id;
  });

  afterAll(async () => {
    await cleanupTenant(tenantId);
    await new Promise<void>((resolve, reject) =>
      server.close((e) => (e ? reject(e) : resolve())),
    );
  });

  it("成功：标题带成功，表格+文件说明+双链接齐全", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "sql-ok",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: {
        url: `${baseUrl}/sql-ok`,
        method: "GET",
      },
      recipients: ["ops@example.com"],
      notifyOn: ["succeeded", "failed"],
      emailSubjectTemplate: "【SQL定时查询】{任务名称} · {执行状态}",
      emailBodyTemplate:
        "任务名称：{任务名称} 执行时间：{执行时间} 总数：{结果总数量} 行 格式：{文件格式} 预览：{预览行数} {预览结果表格} 说明：{文件说明} 下载：{文件链接} 查看：{站内链接}",
      emailSubjectTemplateFailed: "【SQL定时查询】{任务名称} · {执行状态}",
      emailBodyTemplateFailed: "任务名称：{任务名称} 执行时间：{执行时间} 失败原因：{失败原因} 查看：{站内链接}",
      emailAttachmentUrlTemplate: "{文件链接}",
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("succeeded");

    const emails = await prisma.emailLog.findMany({ where: { taskId: task.id } });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe("【SQL定时查询】任务名 · 成功");
    expect(emails[0]!.html).toContain("<table");
    expect(emails[0]!.html).toContain("张三");
    expect(emails[0]!.html).toContain("总数：1286 行");
    expect(emails[0]!.html).toContain("1.80 MB");
    expect(emails[0]!.html).toContain("http://www.xxx.com/yyy/zzz");
    expect(emails[0]!.attachmentUrl).toBe(
      "https://minio.example.com/scheduled-task/xxx/result.xlsx",
    );
  });

  it("失败：执行 failed，失败模板+失败原因", async () => {
    const task = await taskService.create(tenantId, ownerTokenId, {
      name: "sql-fail",
      cron: "*/5 * * * *",
      taskType: "http",
      payload: {
        url: `${baseUrl}/sql-fail`,
        method: "GET",
      },
      recipients: ["ops@example.com"],
      notifyOn: ["succeeded", "failed"],
      emailSubjectTemplate: "【SQL定时查询】{任务名称} · {执行状态}",
      emailBodyTemplate: "成功正文",
      emailSubjectTemplateFailed: "【SQL定时查询】{任务名称} · {执行状态}",
      emailBodyTemplateFailed: "任务名称：{任务名称} 执行时间：{执行时间} 失败原因：{失败原因} 查看：{站内链接}",
    });
    const def = await loadTaskDef(task.id);
    const outcome = await runTaskWithScheduledAt(def, new Date(), "scheduled");
    expect(outcome.status).toBe("failed");

    const emails = await prisma.emailLog.findMany({ where: { taskId: task.id } });
    expect(emails).toHaveLength(1);
    expect(emails[0]!.subject).toBe("【SQL定时查询】任务名 · 失败");
    expect(emails[0]!.html).toContain("失败原因：SQL 执行超时");
    expect(emails[0]!.html).toContain("查看：http://www.xxx.com/yyy/zzz");
    expect(emails[0]!.html).not.toContain("成功正文");
  });
});
