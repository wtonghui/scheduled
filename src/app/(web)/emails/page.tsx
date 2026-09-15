"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { ApiClientError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/cn";
import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { Fragment, useCallback, useEffect, useState } from "react";

interface EmailLog {
  id: string;
  runId: string;
  taskId: string;
  toAddress: string;
  subject: string;
  html: string | null;
  text: string | null;
  status: string;
  attempts: number;
  messageId: string | null;
  sentAt: string | null;
  lastError: string | null;
  attachmentUrl: string | null;
  systemUserId: string | null;
  createdAt: string;
  updatedAt: string;
}

const STATUS_TONE: Record<string, "ok" | "info" | "bad" | "warn" | "neutral"> = {
  sent: "ok",
  pending: "info",
  in_progress: "info",
  failed: "bad",
  dead: "bad",
};

export default function EmailsPage() {
  const { isAuthed } = useAuth();
  const [logs, setLogs] = useState<EmailLog[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState("all");
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      params.set("pageSize", "50");
      const q = params.toString() ? `?${params.toString()}` : "";
      const { data, meta } = await api.get<EmailLog[]>(`/api/v1/email-log${q}`);
      setLogs(data);
      setTotal(meta?.total ?? data.length);
    } catch (err) {
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <div>
      <PageHeader
        title="邮件"
        subtitle={`共 ${total} 条邮件投递记录`}
        actions={
          !isAuthed ? (
            <span className="text-[13px] text-text-muted">未登录 · 请先登录查看</span>
          ) : undefined
        }
      />
      <p className="mb-3 text-[12px] text-text-muted">仅展示近 90 天记录，更早的已归档。</p>

      <div className="mb-4 flex items-center gap-3">
        <div>
          <Label htmlFor="status-filter" className="text-[13px]">
            状态
          </Label>
          <Select
            id="status-filter"
            value={statusFilter}
            onValueChange={setStatusFilter}
            options={[
              { value: "all", label: "全部" },
              { value: "sent", label: "已发送" },
              { value: "pending", label: "待发送" },
              { value: "in_progress", label: "发送中" },
              { value: "failed", label: "失败" },
              { value: "dead", label: "已放弃" },
            ]}
            className="mt-1 ml-1 w-32"
          />
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
        >
          {error}
        </div>
      )}

      {loading ? (
        <Spinner />
      ) : logs.length === 0 ? (
        <EmptyState title="暂无邮件记录" hint="任务执行后触发的通知邮件会显示在这里" />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-text-faint">
                  <th className="px-4 py-2 font-medium w-8"></th>
                  <th className="px-4 py-2 font-medium">状态</th>
                  <th className="px-4 py-2 font-medium">主题</th>
                  <th className="px-4 py-2 font-medium">收件人</th>
                  <th className="px-4 py-2 font-medium">尝试</th>
                  <th className="px-4 py-2 font-medium">发送时间</th>
                  <th className="px-4 py-2 font-medium">附件</th>
                  <th className="px-4 py-2 font-medium">任务</th>
                </tr>
              </thead>
              <tbody>
                {logs.map((log) => (
                  <Fragment key={log.id}>
                    <tr
                      key={log.id}
                      className="border-b border-line last:border-b-0 cursor-pointer hover:bg-surface-hover"
                      onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}
                    >
                      <td className="px-4 py-2.5">
                        {expandedId === log.id ? (
                          <ChevronDown className="size-4 text-text-muted" />
                        ) : (
                          <ChevronRight className="size-4 text-text-muted" />
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Badge tone={STATUS_TONE[log.status] ?? "neutral"}>{log.status}</Badge>
                      </td>
                      <td className="max-w-48 truncate px-4 py-2.5" title={log.subject}>
                        {log.subject}
                      </td>
                      <td
                        className="max-w-48 truncate px-4 py-2.5 font-mono text-xs text-text-muted"
                        title={log.toAddress}
                      >
                        {log.toAddress}
                      </td>
                      <td className="px-4 py-2.5">{log.attempts}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-text-muted whitespace-nowrap">
                        {log.sentAt ? new Date(log.sentAt).toLocaleString() : "—"}
                      </td>
                      <td className="px-4 py-2.5">
                        {log.attachmentUrl ? (
                          <a
                            href={log.attachmentUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="text-info hover:underline"
                          >
                            下载
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/tasks/${log.taskId}`}
                          className="font-mono text-xs text-info hover:underline"
                          onClick={(e) => e.stopPropagation()}
                        >
                          {log.taskId.slice(0, 8)}…
                        </Link>
                      </td>
                    </tr>
                    {expandedId === log.id && (
                      <tr
                        key={`${log.id}-detail`}
                        className="border-b border-line last:border-b-0 bg-surface-sunken"
                      >
                        <td colSpan={8} className="px-8 py-4">
                          {log.text && (
                            <div className="mb-4">
                              <p className="mb-1 text-[11px] font-medium tracking-wide text-text-faint">
                                纯文本正文
                              </p>
                              <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-line bg-surface p-3 text-xs text-text-muted">
                                {log.text}
                              </pre>
                            </div>
                          )}
                          {log.html && (
                            <div className="mb-4">
                              <p className="mb-1 text-[11px] font-medium tracking-wide text-text-faint">
                                HTML 正文
                              </p>
                              <div
                                className="max-h-96 overflow-auto rounded border border-line bg-surface p-3 text-xs"
                                dangerouslySetInnerHTML={{ __html: log.html }}
                              />
                            </div>
                          )}
                          {log.lastError && (
                            <div>
                              <p className="mb-1 text-[11px] font-medium tracking-wide text-text-faint">
                                错误信息
                              </p>
                              <pre className="max-h-40 overflow-auto whitespace-pre-wrap rounded border border-bad/30 bg-bad-soft p-3 text-xs text-bad">
                                {log.lastError}
                              </pre>
                            </div>
                          )}
                          {!log.text && !log.html && !log.lastError && (
                            <p className="text-xs text-text-faint">无正文内容</p>
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
