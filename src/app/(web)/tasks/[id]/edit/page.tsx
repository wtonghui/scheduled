"use client";

import TaskForm, { type TaskFormValues } from "@/components/tasks/task-form";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Spinner } from "@/components/ui/spinner";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

/**
 * 编辑任务页：加载详情 → 预填共享表单 → PATCH（optimistic lock via version）。
 * 409 冲突自动重新拉取并把表单重置为最新内容（remount）。
 */

interface TaskDetail {
  id: string;
  name: string;
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
  emailSubjectTemplateFailed: string | null;
  emailBodyTemplateFailed: string | null;
  emailAttachmentUrlTemplate: string | null;
  taskType: "http" | "noop";
  payload: Record<string, unknown>;
  enabled: boolean;
  maxAttempts: number;
  timeoutMs: number;
  recipients: string[];
  notifyOn: string[];
  webhookUrl: string | null;
  systemUserId?: string | null;
  nextRunAt: string | null;
  version: number;
  writable: boolean;
}

export default function EditTaskPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;
  const router = useRouter();
  const { isAuthed } = useAuth();
  const { toast } = useToast();

  const [task, setTask] = useState<TaskDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<TaskDetail>(`/api/v1/tasks/${id}`);
      setTask(data);
    } catch (err) {
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (!isAuthed) {
      router.replace(`/tasks/${id}`);
    }
  }, [isAuthed, id, router]);

  if (!isAuthed) {
    return <EmptyState title="需要登录后才能编辑任务" hint="正在跳转…" />;
  }

  if (loading) {
    return <Spinner />;
  }

  if (!task) {
    return error ? (
      <div
        role="alert"
        className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
      >
        {error}
      </div>
    ) : null;
  }

  if (!task.writable) {
    return (
      <EmptyState title="该任务为只读" hint="非本租户任务无法编辑（登录本租户账号后可编辑）">
        <Button asChild variant="primary">
          <Link href={`/tasks/${task.id}`}>返回任务详情</Link>
        </Button>
      </EmptyState>
    );
  }

  const save = async (values: TaskFormValues) => {
    await api.patch<TaskDetail>(`/api/v1/tasks/${id}`, {
      name: values.name,
      cron: values.cron ?? null,
      scheduleIntervalSeconds: values.scheduleIntervalSeconds ?? null,
      runAt: values.runAt ?? null,
      timezone: values.timezone ?? null,
      retryDelayMs: values.retryDelayMs ?? null,
      ...(values.overlapPolicy ? { overlapPolicy: values.overlapPolicy } : {}),
      endsAt: values.endsAt ?? null,
      maxRuns: values.maxRuns ?? null,
      startsAt: values.startsAt ?? null,
      skipHolidays: values.skipHolidays ?? false,
      ...(values.holidayPolicy ? { holidayPolicy: values.holidayPolicy } : {}),
      emailSubjectTemplate: values.emailSubjectTemplate ?? null,
      emailBodyTemplate: values.emailBodyTemplate ?? null,
      emailSubjectTemplateFailed: values.emailSubjectTemplateFailed ?? null,
      emailBodyTemplateFailed: values.emailBodyTemplateFailed ?? null,
      emailAttachmentUrlTemplate: values.emailAttachmentUrlTemplate ?? null,
      taskType: values.taskType,
      payload:
        values.taskType === "http"
          ? {
              url: values.url,
              method: values.method,
              ...(Object.keys(values.params).length > 0 ? { params: values.params } : {}),
              headers: values.headers,
              ...(typeof values.body === "string" ? { body: values.body } : {}),
            }
          : {},
      recipients: values.recipients,
      notifyOn: values.notifyOn,
      webhookUrl: values.webhookUrl || null,
      ...(values.systemUserId ? { systemUserId: values.systemUserId } : {}),
      version: task.version,
    });
    toast("已保存，调度下轮轮询生效", "success");
    router.push(`/tasks/${id}`);
  };

  /** 409 版本冲突：拉取最新内容并重置表单。 */
  const handleConflict = async () => {
    toast("检测到版本冲突，已加载最新内容，请重新编辑", "info");
    try {
      const { data } = await api.get<TaskDetail>(`/api/v1/tasks/${id}`);
      setTask(data);
      setFormKey((k) => k + 1);
    } catch (err) {
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    }
  };

  return (
    <div className="mx-auto max-w-2xl">
      <Link href={`/tasks/${task.id}`} className="text-[13px] text-text-muted hover:text-text">
        ← {task.name}
      </Link>

      <PageHeader title="编辑任务" subtitle="保存后立即生效，version 乐观锁防并发覆盖" />

      {error && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
        >
          {error}
        </div>
      )}

      <TaskForm
        key={formKey}
        mode="edit"
        initial={{
          name: task.name,
          taskType: task.taskType,
          cron: task.cron,
          scheduleIntervalSeconds: task.scheduleIntervalSeconds,
          runAt: task.runAt,
          timezone: task.timezone,
          retryDelayMs: task.retryDelayMs,
          overlapPolicy: task.overlapPolicy,
          endsAt: task.endsAt,
          maxRuns: task.maxRuns,
          startsAt: task.startsAt,
          skipHolidays: task.skipHolidays,
          holidayPolicy: task.holidayPolicy,
          emailSubjectTemplate: task.emailSubjectTemplate,
          emailBodyTemplate: task.emailBodyTemplate,
          emailSubjectTemplateFailed: task.emailSubjectTemplateFailed,
          emailBodyTemplateFailed: task.emailBodyTemplateFailed,
          emailAttachmentUrlTemplate: task.emailAttachmentUrlTemplate,
          payload: task.payload,
          recipients: task.recipients,
          notifyOn: task.notifyOn,
          webhookUrl: task.webhookUrl,
          systemUserId: task.systemUserId ?? "",
        }}
        submitLabel="保存修改"
        busyLabel="保存中…"
        cancelHref={`/tasks/${task.id}`}
        onSubmit={save}
        onConflict={handleConflict}
      />
    </div>
  );
}
