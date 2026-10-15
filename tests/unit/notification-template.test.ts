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

  it("appends a download link when the body lacks the attachment url", async () => {
    const out = await renderTaskEmail(summary, {
      subject: " done",
      body: "共 {rowCount} 行",
      attachmentUrl: "{fileUrl}",
    });
    expect(out.html).toContain("附件下载");
    expect(out.html).toContain('href="https://minio.example.com/scheduled-task/xxx/result.xlsx"');
    expect(out.text).toContain(
      "附件下载：https://minio.example.com/scheduled-task/xxx/result.xlsx",
    );
  });

  it("renders SQL preview table (first 20 rows), status and Chinese aliases", async () => {
    const rows = Array.from({ length: 30 }, (_, i) => ({ id: i + 1, name: `n${i + 1}` }));
    const out = await renderTaskEmail(
      {
        ...summary,
        taskName: "任务名",
        result: {
          status: 200,
          redirects: 0,
          attempt: 1,
          data: {
            code: 200,
            msg: "成功",
            data: {
              taskName: "任务名",
              executionAt: "2026-09-18 11:11:00",
              rowCount: 1286,
              fileUrl: "https://minio.example.com/scheduled-task/xxx/result.xlsx",
              fileSize: 1887436,
              fileType: "xlsx",
              fileName: "文件名",
              previewRowCount: 500,
              previewFileds: JSON.stringify(["id", "name"]),
              previewContent: JSON.stringify(rows),
              viewUrl: "http://www.xxx.com/yyy/zzz",
            },
          },
        },
      },
      {
        subject: "【SQL定时查询】{任务名称} · {执行状态}",
        body: "任务名称：{任务名称} 执行时间：{执行时间} 总数：{结果总数量} 行 格式：{文件格式} 预览：{预览行数} {预览结果表格} 说明：{文件说明} 下载：{文件链接} 查看：{站内链接}",
        attachmentUrl: "{文件链接}",
      },
    );
    expect(out.subject).toBe("【SQL定时查询】任务名 · 成功");
    expect(out.html).toContain("任务名称：任务名");
    expect(out.html).toContain("总数：1286 行");
    expect(out.html).toContain("<table");
    // 只取前 20 行：第 20 行在，第 21 行不在
    expect(out.html).toContain("<td>20</td>");
    expect(out.html).not.toContain("<td>21</td>");
    expect(out.html).toContain("1.80 MB");
    expect(out.html).toContain("http://www.xxx.com/yyy/zzz");
  });

  it("resolves failure reason from outer msg when result is absent", async () => {
    const out = await renderTaskEmail(
      {
        ...summary,
        status: "failed" as const,
        errorMessage: "SQL 执行超时",
        result: undefined,
      },
      {
        subject: "【SQL定时查询】{任务名称} · {执行状态}",
        body: "任务名称：{任务名称} 失败原因：{失败原因} 查看：{站内链接}",
      },
    );
    expect(out.subject).toBe("【SQL定时查询】每日对账 · 失败");
    expect(out.html).toContain("失败原因：SQL 执行超时");
  });

  it("picks failed templates on failure and falls back when absent", async () => {
    const failed = {
      ...summary,
      status: "failed" as const,
      errorMessage: "SQL 执行超时",
      result: {
        status: 200,
        redirects: 0,
        attempt: 1,
        data: {
          code: 0,
          msg: "SQL 执行超时",
          data: { taskName: "任务名", executionAt: "2026-09-18 11:11:00" },
        },
      },
    };
    const out = await renderTaskEmail(failed, {
      subject: "成功标题",
      body: "成功正文",
      subjectFailed: "【SQL定时查询】{任务名称} · {执行状态}",
      bodyFailed: "失败原因：{失败原因}",
    });
    expect(out.subject).toBe("【SQL定时查询】任务名 · 失败");
    expect(out.html).toContain("失败原因：SQL 执行超时");

    // 失败专用缺席 → 回退成功模板
    const fallback = await renderTaskEmail(failed, {
      subject: "标题 {执行状态}",
      body: "正文 {执行状态}",
    });
    expect(fallback.subject).toBe("标题 失败");
    expect(fallback.html).toContain("正文 失败");
  });

  it("beautifies the recommended template: line breaks kept, file/site links become buttons", async () => {
    const out = await renderTaskEmail(
      {
        ...summary,
        result: {
          status: 200,
          redirects: [],
          attempt: 1,
          data: {
            code: 200,
            msg: "成功",
            data: {
              taskName: "每日对账",
              executionAt: "2026-09-18 11:11:00",
              rowCount: 1286,
              fileType: "xlsx",
              fileUrl: "https://minio.example.com/scheduled-task/xxx/result.xlsx",
              viewUrl: "http://www.xxx.com/yyy/zzz",
            },
          },
        },
      },
      {
        subject: "【SQL定时查询】{任务名称}",
        body: "任务名称：{任务名称}\n执行时间：{执行时间}\n结果总数量：{结果总数量}行\n文件格式：{文件格式}\n下载链接：{文件链接}\n点击查看本次执行详情：{站内链接}",
      },
    );
    // 换行保留为 <br>
    expect(out.html).toContain("任务名称：每日对账<br>执行时间：");
    // 文件/站内链接按钮化（URL 只进 href，正文只留按钮文案）
    expect(out.html).toContain('href="https://minio.example.com/scheduled-task/xxx/result.xlsx"');
    expect(out.html).toContain(">下载附件</a>");
    expect(out.html).toContain('href="http://www.xxx.com/yyy/zzz"');
    expect(out.html).toContain(">查看详情</a>");
    // 纯文本版保留裸 URL 与原始换行
    expect(out.text).toContain("任务名称：每日对账\n执行时间：2026-09-18 11:11:00");
    expect(out.text).toContain("下载链接：https://minio.example.com/scheduled-task/xxx/result.xlsx");
    expect(out.text).toContain("点击查看本次执行详情：http://www.xxx.com/yyy/zzz");
  });

  it("does not duplicate the link when the body already contains the url", async () => {
    const out = await renderTaskEmail(summary, {
      subject: "任务完成 — {rowCount} 行",
      body: '共 {rowCount} 行<br><a href="{fileUrl}">下载文件</a>',
      attachmentUrl: "{fileUrl}",
    });
    expect(out.html.match(/附件下载/g) ?? []).toHaveLength(0);
  });
});
