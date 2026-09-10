"use client";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { ApiClientError } from "@/lib/api-client";
import { DateTime } from "luxon";
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
  runAt: string | null;
  timezone: string;
  retryDelayMs: number | null;
  overlapPolicy: string;
  endsAt: string | null;
  maxRuns: number | null;
  startsAt: string | null;
  skipHolidays: boolean;
  holidayPolicy: string;
  emailSubjectTemplate: string | null;
  emailBodyTemplate: string | null;
  emailAttachmentUrlTemplate: string | null;
  payload: Record<string, unknown>;
  recipients: string[];
  notifyOn: string[];
  webhookUrl?: string | null;
  systemUserId?: string | null;
}

/** onSubmit 收到的规范化值；body 为 http 任务的透传字段（保持不丢失）。 */
export interface TaskFormValues {
  name: string;
  cron?: string;
  scheduleIntervalSeconds?: number;
  /** 一次性时刻（ISO，UTC）；与 cron/interval 三选一 */
  runAt?: string;
  /** cron/一次性墙钟解析用 IANA 时区 */
  timezone?: string;
  /** 重试等待基线（毫秒），不填=默认退避 */
  retryDelayMs?: number;
  /** 重叠策略：skip 跳过 / queue 排队 / run 允许并行（仅重复调度） */
  overlapPolicy?: string;
  /** 截止时刻（ISO，UTC；仅重复调度，可与 maxRuns 共存） */
  endsAt?: string;
  /** 总次数上限（仅重复调度） */
  maxRuns?: number;
  /** 开始时刻（ISO，UTC；仅 cron/interval，首跑从此起算） */
  startsAt?: string;
  /** 到点遇假日是否跳过/顺延（仅 cron/interval） */
  skipHolidays?: boolean;
  /** drop 作废 / postpone 顺延到下一工作日同墙钟时刻 */
  holidayPolicy?: string;
  /** 邮件标题模板；空=默认标题 */
  emailSubjectTemplate?: string;
  /** 邮件正文模板（HTML）；空=默认 React Email 模板 */
  emailBodyTemplate?: string;
  /** 附件 URL 模板（{xxx} 占位）；空=无附件 */
  emailAttachmentUrlTemplate?: string;
  taskType: "http" | "noop";
  url: string;
  method: string;
  /** URL query 参数（GET/POST 均可，执行时并入 url） */
  params: Record<string, string | number | boolean>;
  headers: Record<string, string>;
  body: string | null;
  webhookUrl: string;
  systemUserId: string;
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

const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** 时区预设（cron/一次性墙钟解析用；完整 IANA 走 API）。 */
const TIMEZONE_OPTIONS = [
  { value: "Asia/Shanghai", label: "北京时间（Asia/Shanghai）" },
  { value: "UTC", label: "UTC" },
  { value: "Asia/Tokyo", label: "东京（Asia/Tokyo）" },
  { value: "Europe/London", label: "伦敦（Europe/London）" },
  { value: "America/New_York", label: "纽约（America/New_York）" },
  { value: "America/Los_Angeles", label: "洛杉矶（America/Los_Angeles）" },
  { value: "Australia/Sydney", label: "悉尼（Australia/Sydney）" },
];

type ScheduleKind = "cron" | "interval" | "once";

/** ISO 时刻 → datetime-local 输入值（按给定墙钟时区展示）。 */
function toLocalInput(iso: string, timezone: string): string {
  const dt = DateTime.fromISO(iso, { setZone: true }).setZone(timezone);
  return dt.isValid ? dt.toFormat("yyyy-MM-dd'T'HH:mm") : "";
}

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
    systemUserId: (initial as any)?.systemUserId ?? "",
    recipients: (initial?.recipients ?? [DEFAULT_RECIPIENT]).join(","),
    notifySuccessMode: (initial?.notifyOn ?? ["succeeded", "failed"]).includes("succeeded")
      ? ("all" as const)
      : (initial?.notifyOn ?? []).includes("succeeded_with_results")
        ? ("results" as const)
        : ("none" as const),
    notifyFailed: (initial?.notifyOn ?? ["succeeded", "failed"]).includes("failed"),
  }));

  const [schedule, setSchedule] = useState<ScheduleResult>(() =>
    initial?.scheduleIntervalSeconds
      ? { scheduleIntervalSeconds: initial.scheduleIntervalSeconds }
      : initial?.cron
        ? { cron: initial.cron }
        : { cron: "0 0 * * *" },
  );
  /** 调度方式三选一：cron 重复 / 固定间隔 / 仅执行一次。 */
  const [scheduleKind, setScheduleKind] = useState<ScheduleKind>(() =>
    initial?.runAt ? "once" : initial?.scheduleIntervalSeconds ? "interval" : "cron",
  );
  /** 秒级固定间隔（新建 interval 模式与编辑历史任务共用）。 */
  const [intervalSeconds, setIntervalSeconds] = useState<number | undefined>(
    initial?.scheduleIntervalSeconds ?? undefined,
  );
  /** 一次性墙钟（datetime-local），按所选时区解析为绝对时刻。 */
  const [runAtLocal, setRunAtLocal] = useState(() =>
    initial?.runAt ? toLocalInput(initial.runAt, initial.timezone ?? DEFAULT_TIMEZONE) : "",
  );
  const [timezone, setTimezone] = useState(initial?.timezone ?? DEFAULT_TIMEZONE);
  /** 重试等待基线（秒），空=默认退避。 */
  const [retryDelaySec, setRetryDelaySec] = useState(() =>
    initial?.retryDelayMs != null ? String(initial.retryDelayMs / 1000) : "",
  );
  const [overlapPolicy, setOverlapPolicy] = useState(initial?.overlapPolicy ?? "skip");
  /** 截止墙钟（datetime-local），按所选时区解析为绝对时刻。 */
  const [endsAtLocal, setEndsAtLocal] = useState(() =>
    initial?.endsAt ? toLocalInput(initial.endsAt, initial.timezone ?? DEFAULT_TIMEZONE) : "",
  );
  const [maxRuns, setMaxRuns] = useState(() =>
    initial?.maxRuns != null ? String(initial.maxRuns) : "",
  );
  /** 开始墙钟（datetime-local），按所选时区解析为绝对时刻。 */
  const [startsAtLocal, setStartsAtLocal] = useState(() =>
    initial?.startsAt ? toLocalInput(initial.startsAt, initial.timezone ?? DEFAULT_TIMEZONE) : "",
  );
  const [skipHolidays, setSkipHolidays] = useState(initial?.skipHolidays ?? false);
  const [holidayPolicy, setHolidayPolicy] = useState(initial?.holidayPolicy ?? "drop");
  const [emailSubjectTemplate, setEmailSubjectTemplate] = useState(
    initial?.emailSubjectTemplate ?? "",
  );
  const [emailBodyTemplate, setEmailBodyTemplate] = useState(initial?.emailBodyTemplate ?? "");
  const [emailAttachmentUrlTemplate, setEmailAttachmentUrlTemplate] = useState(
    initial?.emailAttachmentUrlTemplate ?? "",
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
    let runAtIso: string | undefined;
    if (scheduleKind === "cron" && !schedule.cron) {
      setError("请填写调度计划（结构化选择 / 高级 cron）");
      return;
    }
    if (scheduleKind === "interval" && (!interval || interval < 1)) {
      setError("请填写固定间隔（≥1 秒）");
      return;
    }
    if (scheduleKind === "once") {
      if (!runAtLocal) {
        setError("请填写执行时间（仅执行一次）");
        return;
      }
      const dt = DateTime.fromFormat(runAtLocal, "yyyy-MM-dd'T'HH:mm", { zone: timezone });
      if (!dt.isValid || dt.toMillis() <= Date.now()) {
        setError("执行时间必须是未来时刻");
        return;
      }
      runAtIso = dt.toUTC().toISO() ?? undefined;
    }
    let retryDelayMs: number | undefined;
    if (retryDelaySec.trim()) {
      const sec = Number(retryDelaySec);
      if (!Number.isFinite(sec) || sec < 0 || sec > 3600) {
        setError("重试等待须为 0–3600 秒");
        return;
      }
      retryDelayMs = Math.round(sec * 1000);
    }
    // 结束规则（仅重复调度）：截止时刻按所选时区解析；次数≥1
    let endsAtIso: string | undefined;
    let maxRunsNum: number | undefined;
    let startsAtIso: string | undefined;
    if (scheduleKind !== "once") {
      if (endsAtLocal) {
        const dt = DateTime.fromFormat(endsAtLocal, "yyyy-MM-dd'T'HH:mm", { zone: timezone });
        if (!dt.isValid || dt.toMillis() <= Date.now()) {
          setError("截止时间必须是未来时刻");
          return;
        }
        endsAtIso = dt.toUTC().toISO() ?? undefined;
      }
      if (startsAtLocal) {
        const dt = DateTime.fromFormat(startsAtLocal, "yyyy-MM-dd'T'HH:mm", { zone: timezone });
        if (!dt.isValid || dt.toMillis() <= Date.now()) {
          setError("开始时间必须是未来时刻");
          return;
        }
        startsAtIso = dt.toUTC().toISO() ?? undefined;
      }
      if (endsAtIso && startsAtIso && startsAtIso >= endsAtIso) {
        setError("开始时间必须早于截止时间");
        return;
      }
      if (maxRuns.trim()) {
        const n = Number(maxRuns);
        if (!Number.isInteger(n) || n < 1 || n > 1_000_000) {
          setError("总次数须为 1–1000000 的整数");
          return;
        }
        maxRunsNum = n;
      }
    }

    const values: TaskFormValues = {
      name: form.name,
      cron: scheduleKind === "cron" ? schedule.cron : undefined,
      scheduleIntervalSeconds: scheduleKind === "interval" ? interval : undefined,
      runAt: runAtIso,
      timezone: scheduleKind === "interval" ? undefined : timezone,
      retryDelayMs,
      overlapPolicy: scheduleKind === "once" ? undefined : overlapPolicy,
      endsAt: endsAtIso,
      maxRuns: maxRunsNum,
      startsAt: startsAtIso,
      skipHolidays: scheduleKind === "once" ? undefined : skipHolidays || undefined,
      holidayPolicy: scheduleKind === "once" || !skipHolidays ? undefined : holidayPolicy,
      emailSubjectTemplate: emailSubjectTemplate.trim() || undefined,
      emailBodyTemplate: emailBodyTemplate.trim() || undefined,
      emailAttachmentUrlTemplate: emailAttachmentUrlTemplate.trim() || undefined,
      taskType: form.taskType,
      url: form.url,
      method: form.method,
      params,
      headers,
      body: form.body,
      webhookUrl: form.webhookUrl.trim(),
      systemUserId: form.systemUserId.trim() || undefined,
      recipients: form.recipients
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      notifyOn: [
        ...(form.notifySuccessMode === "all"
          ? ["succeeded" as const]
          : form.notifySuccessMode === "results"
            ? ["succeeded_with_results" as const]
            : []),
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
            <Label>调度方式</Label>
            <Select
              value={scheduleKind}
              onValueChange={(v) => setScheduleKind(v as ScheduleKind)}
              className="mt-1.5 max-w-60"
              options={[
                { value: "cron", label: "重复（cron）" },
                { value: "interval", label: "固定间隔" },
                { value: "once", label: "仅执行一次" },
              ]}
            />
          </div>

          <div className="col-span-2 mt-4">
            {scheduleKind === "interval" ? (
              <div className="max-w-72">
                <Label htmlFor="task-interval">固定间隔（秒）</Label>
                <Input
                  id="task-interval"
                  type="number"
                  min={1}
                  value={intervalSeconds ?? ""}
                  onChange={(e) => setIntervalSeconds(Math.max(1, Number(e.target.value) || 1))}
                  className="mt-1.5"
                />
                <p className="mt-1 text-xs text-text-faint">
                  按固定秒数轮询调度（顺延语义，不对齐整点）
                </p>
              </div>
            ) : scheduleKind === "once" ? (
              <div className="max-w-72">
                <Label htmlFor="task-run-at">执行时间（到点跑一次，跑完自动停用）</Label>
                <Input
                  id="task-run-at"
                  type="datetime-local"
                  value={runAtLocal}
                  onChange={(e) => setRunAtLocal(e.target.value)}
                  className="mt-1.5"
                />
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

          {scheduleKind !== "interval" && (
            <div className="mt-4 max-w-72">
              <Label>时区（cron/执行时间按此时钟解析）</Label>
              <Select
                value={timezone}
                onValueChange={setTimezone}
                className="mt-1.5"
                options={TIMEZONE_OPTIONS}
              />
            </div>
          )}

          <div className="mt-4 max-w-72">
            <Label htmlFor="task-retry-delay">重试等待基线（秒，可空=默认退避）</Label>
            <Input
              id="task-retry-delay"
              type="number"
              min={0}
              max={3600}
              value={retryDelaySec}
              onChange={(e) => setRetryDelaySec(e.target.value)}
              placeholder="默认 1 秒起退避；实际 0~基线×2ⁿ 随机"
              className="mt-1.5"
            />
          </div>

          {scheduleKind !== "once" && (
            <>
              <div className="mt-4 max-w-72">
                <Label>重叠策略（上次未结束又到点）</Label>
                <Select
                  value={overlapPolicy}
                  onValueChange={setOverlapPolicy}
                  className="mt-1.5"
                  options={[
                    { value: "skip", label: "跳过本次（默认）" },
                    { value: "queue", label: "排队等上次跑完" },
                    { value: "run", label: "允许并行（自担双跑风险）" },
                  ]}
                />
              </div>
              <div className="mt-4 max-w-72">
                <Label htmlFor="task-ends-at">截止时间（可空=持续到手动停）</Label>
                <Input
                  id="task-ends-at"
                  type="datetime-local"
                  value={endsAtLocal}
                  onChange={(e) => setEndsAtLocal(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div className="mt-4 max-w-72">
                <Label htmlFor="task-max-runs">总次数（可空=不限，可与截止共存）</Label>
                <Input
                  id="task-max-runs"
                  type="number"
                  min={1}
                  max={1000000}
                  value={maxRuns}
                  onChange={(e) => setMaxRuns(e.target.value)}
                  placeholder="如 100"
                  className="mt-1.5"
                />
              </div>
              <div className="mt-4 max-w-72">
                <Label htmlFor="task-starts-at">开始时间（可空=立即开始）</Label>
                <Input
                  id="task-starts-at"
                  type="datetime-local"
                  value={startsAtLocal}
                  onChange={(e) => setStartsAtLocal(e.target.value)}
                  className="mt-1.5"
                />
              </div>
              <div className="mt-4 flex items-center gap-2">
                <Switch
                  id="task-skip-holidays"
                  checked={skipHolidays}
                  onCheckedChange={setSkipHolidays}
                />
                <Label htmlFor="task-skip-holidays" className="cursor-pointer text-[13px]">
                  到点遇节假日跳过（按所选时区查日历）
                </Label>
              </div>
              {skipHolidays && (
                <div className="mt-4 max-w-72">
                  <Label>节假日策略</Label>
                  <Select
                    value={holidayPolicy}
                    onValueChange={setHolidayPolicy}
                    className="mt-1.5"
                    options={[
                      { value: "drop", label: "作废（少跑一次）" },
                      { value: "postpone", label: "顺延到下一工作日" },
                    ]}
                  />
                </div>
              )}
            </>
          )}

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
            <Label htmlFor="task-email-subject">
              邮件标题模板（可空=默认标题。用 {"{字段名}"} 从响应 data 取值）
            </Label>
            <Input
              id="task-email-subject"
              value={emailSubjectTemplate}
              onChange={(e) => setEmailSubjectTemplate(e.target.value)}
              placeholder="如：任务完成 — {rowCount} 行"
              className="mt-1.5 font-mono text-xs"
            />
          </div>
          <div className="col-span-2 mt-4">
            <Label htmlFor="task-email-body">
              邮件正文模板（可空=默认模板。HTML，用 {"{字段名}"} 取值）
            </Label>
            <Textarea
              id="task-email-body"
              value={emailBodyTemplate}
              onChange={(e) => setEmailBodyTemplate(e.target.value)}
              placeholder={'如：共 {rowCount} 行<br><a href="{fileUrl}">下载文件</a>'}
              className="mt-1.5 font-mono text-xs"
            />
          </div>
          <div className="col-span-2 mt-4">
            <Label htmlFor="task-email-attachment">
              附件 URL 模板（可空=无附件。渲染后 relay 下载并附加到邮件）
            </Label>
            <Input
              id="task-email-attachment"
              value={emailAttachmentUrlTemplate}
              onChange={(e) => setEmailAttachmentUrlTemplate(e.target.value)}
              placeholder="如：{fileUrl}"
              className="mt-1.5 font-mono text-xs"
            />
          </div>
          <div className="col-span-2 mt-4">
            <Label htmlFor="task-system-user-id">
              系统用户标识（可选，外部接入系统内具体用户）
            </Label>
            <Input
              id="task-system-user-id"
              name="systemUserId"
              value={form.systemUserId || ""}
              onChange={(e) => set("systemUserId" as any, e.target.value)}
              placeholder="例如：user-123 或 ops-team-a"
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

          <div className="mt-4 max-w-72">
            <Label>成功时通知</Label>
            <Select
              value={form.notifySuccessMode}
              onValueChange={(v) => set("notifySuccessMode", v as typeof form.notifySuccessMode)}
              className="mt-1.5"
              options={[
                { value: "none", label: "不通知" },
                { value: "all", label: "成功即通知" },
                { value: "results", label: "有业务数据才通知" },
              ]}
            />
            <p className="mt-1 text-xs text-text-faint">
              有业务数据 = 上游返回了响应体（HTTP 2xx 非空 body）
            </p>
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
