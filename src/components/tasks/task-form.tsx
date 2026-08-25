"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiClientError } from "@/lib/api-client";
import { useRouter } from "next/navigation";
import { useState } from "react";
import ScheduleBuilder, { type ScheduleResult } from "./ScheduleBuilder";

/**
 * 任务创建/编辑共用的表单组件。
 * create：全部控件从空值开始；edit：按 initial 预填。
 * 客户端只做结构与 JSON 校验；后端错误（含 409 版本冲突）在此统一展示。
 */

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"];

/** 编辑模式的预填数据（= 任务详情视图）。 */
export interface TaskInitial {
  name: string;
  taskType: "http" | "noop";
  cron: string | null;
  scheduleIntervalSeconds: number | null;
  payload: Record<string, unknown>;
  recipients: string[];
  notifyOn: string[];
  webhookUrl?: string | null;
}

/** onSubmit 收到的规范化值；body 为 http 任务的透传字段（保持不丢失）。 */
export interface TaskFormValues {
  name: string;
  cron?: string;
  scheduleIntervalSeconds?: number;
  taskType: "http" | "noop";
  url: string;
  method: string;
  /** URL query 参数（GET/POST 均可，执行时并入 url） */
  params: Record<string, string | number | boolean>;
  headers: Record<string, string>;
  body: string | null;
  webhookUrl: string;
  recipients: string[];
  notifyOn: string[];
}

interface Props {
  mode: "create" | "edit";
  initial?: TaskInitial;
  submitLabel: string;
  busyLabel: string;
  cancelHref: string;
  onSubmit: (values: TaskFormValues) => Promise<void>;
  /** 提交遇 409 版本冲突时调用（编辑页用它重新拉取任务并重置表单）。 */
  onConflict?: () => void;
}

const DEFAULT_RECIPIENT = "ops@example.com";

export default function TaskForm({
  mode,
  initial,
  submitLabel,
  busyLabel,
  cancelHref,
  onSubmit,
  onConflict,
}: Props) {
  const router = useRouter();
  const payload = initial?.payload ?? {};

  const [form, setForm] = useState(() => ({
    name: initial?.name ?? "",
    taskType: initial?.taskType ?? "noop",
    url: typeof payload.url === "string" ? payload.url : "",
    method: typeof payload.method === "string" ? payload.method : "GET",
    params: JSON.stringify(payload.params ?? {}, null, 2),
    headers: JSON.stringify(payload.headers ?? {}, null, 2),
    body: typeof payload.body === "string" ? payload.body : null,
    webhookUrl: initial?.webhookUrl ?? "",
    recipients: (initial?.recipients ?? [DEFAULT_RECIPIENT]).join(","),
    notifySucceeded: (initial?.notifyOn ?? ["succeeded", "failed"]).includes("succeeded"),
    notifyFailed: (initial?.notifyOn ?? ["succeeded", "failed"]).includes("failed"),
  }));

  const [schedule, setSchedule] = useState<ScheduleResult>(() =>
    initial?.scheduleIntervalSeconds
      ? { scheduleIntervalSeconds: initial.scheduleIntervalSeconds }
      : initial?.cron
        ? { cron: initial.cron }
        : { cron: "0 0 * * *" },
  );
  /** 秒级固定间隔仅在编辑历史任务时出现（结构化器不表达秒级间隔）。 */
  const [intervalSeconds, setIntervalSeconds] = useState<number | undefined>(
    initial?.scheduleIntervalSeconds ?? undefined,
  );

  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(key: K, value: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    let params: Record<string, string | number | boolean> = {};
    try {
      params = form.params.trim()
        ? (JSON.parse(form.params) as Record<string, string | number | boolean>)
        : {};
    } catch {
      setError("params 不是合法 JSON");
      return;
    }

    let headers: Record<string, string> = {};
    try {
      headers = form.headers.trim() ? (JSON.parse(form.headers) as Record<string, string>) : {};
    } catch {
      setError("headers 不是合法 JSON");
      return;
    }

    const interval = schedule.scheduleIntervalSeconds ?? intervalSeconds;
    if (!schedule.cron && !interval) {
      setError("请填写调度计划（结构化选择 / 高级 cron / 固定间隔）");
      return;
    }

    const values: TaskFormValues = {
      name: form.name,
      cron: schedule.cron,
      scheduleIntervalSeconds: interval,
      taskType: form.taskType,
      url: form.url,
      method: form.method,
      params,
      headers,
      body: form.body,
      webhookUrl: form.webhookUrl.trim(),
      recipients: form.recipients
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      notifyOn: [
        ...(form.notifySucceeded ? ["succeeded" as const] : []),
        ...(form.notifyFailed ? ["failed" as const] : []),
      ],
    };

    setSaving(true);
    try {
      await onSubmit(values);
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409 && onConflict) {
        onConflict();
        return;
      }
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form onSubmit={submit}>
      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
        >
          {error}
        </div>
      )}

      <Card className="p-5">
        <div className="grid grid-cols-2 gap-x-5">
          <div className="col-span-2">
            <Label htmlFor="task-name">
              名称 <span className="text-bad">*</span>
            </Label>
            <Input
              id="task-name"
              name="name"
              value={form.name}
              onChange={(e) => set("name", e.target.value)}
              required
              placeholder="例如：每日健康检查"
              className="mt-1.5"
            />
          </div>

          <div className="col-span-2 mt-4">
            {intervalSeconds != null && !schedule.cron ? (
              <div className="max-w-72">
                <Label htmlFor="task-interval">固定间隔（秒）</Label>
                <Input
                  id="task-interval"
                  type="number"
                  min={1}
                  value={intervalSeconds}
                  onChange={(e) => setIntervalSeconds(Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-text-faint">
                  按固定秒数轮询调度（不适用于结构化 cron）
                </p>
              </div>
            ) : (
              <ScheduleBuilder
                onChange={setSchedule}
                defaultValue={
                  mode === "edit" && schedule.cron ? { cron: schedule.cron } : undefined
                }
              />
            )}
          </div>

          <div className="mt-4">
            <Label>任务类型</Label>
            <Select
              value={form.taskType}
              onValueChange={(v) => set("taskType", v as "http" | "noop")}
              className="mt-1.5"
              options={[
                { value: "noop", label: "noop（自测）" },
                { value: "http", label: "http" },
              ]}
            />
          </div>

          {form.taskType === "http" && (
            <>
              <div className="mt-4">
                <Label>请求方法</Label>
                <Select
                  value={form.method}
                  onValueChange={(v) => set("method", v)}
                  className="mt-1.5"
                  options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                />
              </div>
              <div className="col-span-2 mt-4">
                <Label htmlFor="task-url">
                  payload.url <span className="text-bad">*</span>
                </Label>
                <Input
                  id="task-url"
                  value={form.url}
                  onChange={(e) => set("url", e.target.value)}
                  placeholder="https://example.com/health"
                  className="mt-1.5"
                />
              </div>
              <div className="col-span-2 mt-4">
                <Label htmlFor="task-params">
                  payload.params（JSON，URL query 参数，敏感字段加密存储）
                </Label>
                <Textarea
                  id="task-params"
                  value={form.params}
                  onChange={(e) => set("params", e.target.value)}
                  className="mt-1.5"
                  placeholder={'{"page":"1","verbose":true}'}
                />
              </div>
              <div className="col-span-2 mt-4">
                <Label htmlFor="task-headers">payload.headers（JSON，敏感字段加密存储）</Label>
                <Textarea
                  id="task-headers"
                  value={form.headers}
                  onChange={(e) => set("headers", e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div className="col-span-2 mt-4">
                <Label htmlFor="task-body">
                  payload.body（请求体，仅 POST/PUT/PATCH/DELETE 生效；敏感字段加密存储）
                </Label>
                <Textarea
                  id="task-body"
                  value={form.body ?? ""}
                  onChange={(e) => set("body", e.target.value || null)}
                  className="mt-1.5"
                  placeholder={"JSON 或原始字符串"}
                />
              </div>
            </>
          )}

          <div className="col-span-2 mt-4">
            <Label htmlFor="task-webhook">
              payload.webhookUrl（任务终态回调地址；可空。带 HMAC 签名头，见 docs）
            </Label>
            <Input
              id="task-webhook"
              value={form.webhookUrl}
              onChange={(e) => set("webhookUrl", e.target.value)}
              placeholder="https://your-server.example.com/hook"
              className="mt-1.5"
            />
          </div>
          <div className="col-span-2 mt-4">
            <Label htmlFor="task-recipients">
              收件人（逗号分隔邮箱） <span className="text-bad">*</span>
            </Label>
            <Input
              id="task-recipients"
              value={form.recipients}
              onChange={(e) => set("recipients", e.target.value)}
              className="mt-1.5"
            />
          </div>

          <div className="mt-4 flex items-center gap-2">
            <Switch
              id="notify-succeeded"
              checked={form.notifySucceeded}
              onCheckedChange={(c) => set("notifySucceeded", c)}
            />
            <Label htmlFor="notify-succeeded" className="cursor-pointer text-[13px]">
              成功时通知
            </Label>
          </div>
          <div className="mt-4 flex items-center gap-2">
            <Switch
              id="notify-failed"
              checked={form.notifyFailed}
              onCheckedChange={(c) => set("notifyFailed", c)}
            />
            <Label htmlFor="notify-failed" className="cursor-pointer text-[13px]">
              失败时通知
            </Label>
          </div>
        </div>

        <div className="mt-5 flex gap-2.5">
          <Button type="submit" variant="primary" disabled={saving}>
            {saving ? busyLabel : submitLabel}
          </Button>
          <Button type="button" variant="secondary" onClick={() => router.push(cancelHref)}>
            取消
          </Button>
        </div>
      </Card>
    </form>
  );
}
