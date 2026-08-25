"use client";

import TaskForm, { type TaskFormValues } from "@/components/tasks/task-form";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

/**
 * 创建任务入口：登录守卫 + 共享表单（提交走 POST）。
 * 表单本体在 src/components/tasks/task-form.tsx。
 */

export default function NewTaskPage() {
  const router = useRouter();
  const { isAuthed } = useAuth();

  useEffect(() => {
    if (!isAuthed) {
      router.replace("/tasks");
    }
  }, [isAuthed, router]);

  if (!isAuthed) {
    return <EmptyState title="需要登录后才能创建任务" hint="正在跳转…" />;
  }

  const create = async (values: TaskFormValues) => {
    const task = await api.post<{ id: string }>("/api/v1/tasks", {
      name: values.name,
      ...(values.cron ? { cron: values.cron } : {}),
      ...(values.scheduleIntervalSeconds
        ? { scheduleIntervalSeconds: values.scheduleIntervalSeconds }
        : {}),
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
      ...(values.webhookUrl ? { webhookUrl: values.webhookUrl } : {}),
      recipients: values.recipients,
      notifyOn: values.notifyOn,
    });
    router.push(`/tasks/${task.data.id}`);
  };

  return (
    <div className="mx-auto max-w-2xl">
      <PageHeader
        title="新建任务"
        subtitle="创建后 next_run_at 按 UTC 计算，worker 下轮轮询即生效"
      />
      <TaskForm
        mode="create"
        submitLabel="创建任务"
        busyLabel="创建中…"
        cancelHref="/tasks"
        onSubmit={create}
      />
    </div>
  );
}
