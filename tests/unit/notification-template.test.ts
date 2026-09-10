import { describe, expect, it } from "vitest";
import { renderTaskEmail } from "../../src/modules/notification/service";

/** 用户实际场景：响应体 {code, msg, data}，模板只用内层 data 字段。 */
const summary = {
  executionId: "ex-test-001",
  taskId: "tk-test-001",
  taskName: "每日对账",
  status: "succeeded" as const,
  scheduledAt: new Date("2026-09-10T01:00:00.000Z"),
  startedAt: new Date("2026-09-10T01:00:01.000Z"),
  finishedAt: new Date("2026-09-10T01:00:02.000Z"),
  durationMs: 1000,
  errorMessage: null,
  result: {
    status: 200,
    redirects: [],
    attempt: 1,
    data: {
      code: 200,
      msg: "回调已接收，验签通过",
      data: {
        executionId: 1889012345678901234,
        rowCount: 1286,
        fileUrl: "https://minio.example.com/scheduled-task/xxx/result.xlsx",
        fileSize: 1887436,
        fileType: "xlsx",
      },
    },
  },
};

describe("renderTaskEmail with user templates (flattened data context)", () => {
  it("matches {rowCount} and {fileUrl} from inner data", async () => {
    const out = await renderTaskEmail(summary, {
      subject: "任务完成 — {rowCount} 行",
      body: '共 {rowCount} 行<br><a href="{fileUrl}">下载文件</a>',
      attachmentUrl: "{fileUrl}",
    });
    expect(out.subject).toBe("任务完成 — 1286 行");
    expect(out.html).toContain("共 1286 行");
    expect(out.html).toContain('href="https://minio.example.com/scheduled-task/xxx/result.xlsx"');
    expect(out.text).toContain("共 1286 行");
    expect(out.attachmentUrl).toBe("https://minio.example.com/scheduled-task/xxx/result.xlsx");
  });

  it("keeps unmatched placeholders as-is", async () => {
    const out = await renderTaskEmail(summary, {
      subject: "{notExist} 完成",
      body: "行数 {rowCount}，缺失 {nope.deep}",
    });
    expect(out.subject).toBe("{notExist} 完成");
    expect(out.html).toContain("行数 1286");
    expect(out.html).toContain("{nope.deep}");
  });

  it("falls back to default template when no templates given", async () => {
    const out = await renderTaskEmail(summary, {});
    expect(out.subject).toContain("每日对账");
    expect(out.html).toContain("ex-test-001");
    expect(out.attachmentUrl).toBeNull();
  });
});
