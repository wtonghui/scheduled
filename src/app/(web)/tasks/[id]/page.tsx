"use client";

import { useConfirm } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

interface TaskDetail {
  id: string;
  name: string;
  cron: string | null;
  scheduleIntervalSeconds: number | null;
  taskType: "http" | "noop";
  payload: Record<string, unknown>;
  enabled: boolean;
  maxAttempts: number;
  timeoutMs: number;
  recipients: string[];
  notifyOn: string[];
  webhookUrl: string | null;
  nextRunAt: string | null;
  version: number;
  writable: boolean;
}

interface Execution {
  id: string;
  status: string;
  attempt: number;
  scheduledAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: string;
  error: Record<string, unknown> | null;
}

const STATUS_TONE: Record<string, "ok" | "info" | "bad" | "warn" | "neutral"> = {
  succeeded: "ok",
  pending: "info",
  running: "info",
  failed: "bad",
  timeout: "warn",
  dead: "bad",
  interrupted: "warn",
};

export default function TaskDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { isAuthed } = useAuth();

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [executions, setExecutions] = useState<Execution[]>([]);
  const [name, setName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data } = await api.get<TaskDetail>(`/api/v1/tasks/${id}`);
      setTask(data);
      setName(data.name);
      setEnabled(data.enabled);
      const ex = await api.get<Execution[]>(`/api/v1/tasks/${id}/executions?pageSize=20`);
      setExecutions(ex.data);
    } catch (err) {
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const save = async () => {
    if (!task) return;
    setBusy(true);
    setError(null);
    try {
      const updated = await api.patch<TaskDetail>(`/api/v1/tasks/${id}`, {
        name,
        enabled,
        version: task.version,
      });
      setTask(updated.data);
      toast(`已保存（version → ${updated.data.version}）`, "success");
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        setError("版本冲突：任务已被其他人修改，请刷新后重试");
      } else {
        setError(err instanceof ApiClientError ? err.message : String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const runNow = async () => {
    try {
      const res = await api.post<{ executionId: string }>(`/api/v1/tasks/${id}/run-now`);
      toast(`已触发运行 ${res.data.executionId}`, "info");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  const remove = async () => {
    const ok = await confirm({
      title: `删除任务「${task?.name}」？`,
      description: "删除后不可恢复，执行记录与 webhook 投递将一并移除。",
      confirmText: "确认删除",
      tone: "bad",
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/tasks/${id}`);
      toast("已删除任务", "success");
      router.push("/tasks");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  if (!task) {
    return error ? (
      <div
        role="alert"
        className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
      >
        {error}
      </div>
    ) : (
      <Spinner />
    );
  }

  const metaItems: Array<[string, React.ReactNode]> = [
    ["标识", <code key="id">{task.id}</code>],
    ["类型", task.taskType],
    ["计划", <code key="cron">{task.cron ?? "—"}</code>],
    [
      "下次运行",
      <code key="next">{task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—"}</code>,
    ],
    ["重试上限", String(task.maxAttempts)],
    ["超时", `${task.timeoutMs}ms`],
    ["收件人", task.recipients.join(", ") || "—"],
    ["回调", task.webhookUrl ? <code key="hook">{task.webhookUrl}</code> : "—"],
  ];

  return (
    <div>
      <Link href="/tasks" className="text-[13px] text-text-muted hover:text-text">
        ← 任务
      </Link>

      <div className="mt-2 mb-4 flex items-center gap-3">
        <h1 className="text-[22px] leading-tight font-semibold text-text">{task.name}</h1>
        <Badge tone={task.enabled ? "ok" : "warn"}>{task.enabled ? "启用" : "停用"}</Badge>
        <Badge tone={task.taskType === "http" ? "info" : "neutral"}>{task.taskType}</Badge>
      </div>

      <div className="mb-5 flex flex-wrap gap-x-6 gap-y-1 text-xs text-text-muted">
        {metaItems.map(([k, v]) => (
          <span key={k}>
            <span className="mr-1 text-text-faint">{k}</span>
            {v}
          </span>
        ))}
      </div>

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
        >
          {error}
        </div>
      )}

      <Card className="mb-6 flex flex-wrap items-end gap-4 p-4">
        <div className="min-w-52 flex-1">
          <Label htmlFor="task-name">名称</Label>
          <Input
            id="task-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={!task.writable}
            className="mt-1.5"
          />
        </div>
        <div className="flex items-center gap-2 pb-2.5">
          <Switch
            id="enabled-toggle"
            checked={enabled}
            onCheckedChange={setEnabled}
            disabled={!task.writable}
          />
          <Label htmlFor="enabled-toggle" className="cursor-pointer text-[13px]">
            启用
          </Label>
        </div>
        {task.writable ? (
          <div className="flex items-center gap-2 pb-1.5">
            <Button asChild variant="secondary" size="sm">
              <Link href={`/tasks/${task.id}/edit`}>编辑</Link>
            </Button>
            <Button variant="primary" size="sm" onClick={save} disabled={busy}>
              {busy ? "保存中…" : "保存"}
            </Button>
            <Button variant="secondary" size="sm" onClick={runNow}>
              立即运行
            </Button>
            <Button variant="danger" size="sm" onClick={remove}>
              删除
            </Button>
          </div>
        ) : (
          <span className="pb-2.5 text-[13px] text-text-muted">
            {isAuthed ? "非本租户 · 只读" : "未登录 · 只读"}
          </span>
        )}
      </Card>

      <h2 className="mb-2.5 text-[15px] font-semibold text-text">配置 payload</h2>
      <Card className="mb-6 p-0">
        <pre className="max-h-72 overflow-x-auto rounded-lg bg-surface-sunken p-4 font-mono text-xs leading-relaxed text-text">
          {JSON.stringify(task.payload, null, 2)}
        </pre>
      </Card>

      <h2 className="mb-2.5 text-[15px] font-semibold text-text">执行记录</h2>
      <Card className="overflow-hidden p-0">
        {executions.length === 0 ? (
          <EmptyState
            title="暂无执行记录"
            hint="点击「立即运行」或等待调度触发"
            className="border-0"
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-text-faint">
                  <th className="px-4 py-2 font-medium">状态</th>
                  <th className="px-4 py-2 font-medium">计划时间</th>
                  <th className="px-4 py-2 font-medium">次数</th>
                  <th className="px-4 py-2 font-medium">耗时</th>
                  <th className="px-4 py-2 font-medium">触发</th>
                </tr>
              </thead>
              <tbody>
                {executions.map((ex) => (
                  <tr key={ex.id} className="border-b border-line last:border-b-0">
                    <td className="px-4 py-2.5">
                      <Badge tone={STATUS_TONE[ex.status] ?? "neutral"}>{ex.status}</Badge>
                    </td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-muted">
                      {new Date(ex.scheduledAt).toLocaleString()}
                    </td>
                    <td className="px-4 py-2.5">{ex.attempt}</td>
                    <td className="px-4 py-2.5 font-mono text-xs text-text-muted">
                      {ex.durationMs != null ? `${ex.durationMs}ms` : "—"}
                    </td>
                    <td className="px-4 py-2.5">{ex.trigger}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
