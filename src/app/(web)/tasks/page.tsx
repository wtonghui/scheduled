"use client";

import { useConfirm } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Select } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ApiClientError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/cn";
import { MoreVertical, Pencil, Play, Power, Trash2 } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";

interface TaskItem {
  id: string;
  name: string;
  cron: string | null;
  scheduleIntervalSeconds: number | null;
  taskType: "http" | "noop";
  enabled: boolean;
  nextRunAt: string | null;
  version: number;
  writable: boolean;
}

function scheduleLabel(t: TaskItem): string {
  return t.cron ?? (t.scheduleIntervalSeconds ? `每 ${t.scheduleIntervalSeconds}s` : "—");
}

const GRID = "grid grid-cols-[2fr_0.9fr_0.7fr_1.2fr_0.8fr_120px] items-center gap-3";

const SKELETON_ROWS = ["sk-1", "sk-2", "sk-3", "sk-4"];

export default function TasksPage() {
  const { isAuthed } = useAuth();
  const [tasks, setTasks] = useState<TaskItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [enabledFilter, setEnabledFilter] = useState("all");
  const [mineOnly, setMineOnly] = useState(false); // 只看我的（租户）
  const [ownerTokenOnly, setOwnerTokenOnly] = useState(false); // 只看当前 api（token 隔离）
  const [systemUserFilter, setSystemUserFilter] = useState(""); // 按系统内用户筛选
  const { toast } = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (enabledFilter !== "all") params.set("enabled", enabledFilter);
      if (mineOnly && isAuthed) params.set("mine", "true");
      if (ownerTokenOnly && isAuthed) params.set("owner", "token");
      if (systemUserFilter.trim()) params.set("system_user_id", systemUserFilter.trim());
      const q = params.toString() ? `?${params.toString()}` : "";
      const { data, meta } = await api.get<TaskItem[]>(`/api/v1/tasks${q}`);
      setTasks(data);
      setTotal(meta?.total ?? data.length);
    } catch (err) {
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    } finally {
      setLoading(false);
    }
  }, [enabledFilter, mineOnly, ownerTokenOnly, systemUserFilter, isAuthed]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (task: TaskItem) => {
    try {
      await api.patch(`/api/v1/tasks/${task.id}`, {
        version: task.version,
        enabled: !task.enabled,
      });
      toast(task.enabled ? "已停用任务" : "已启用任务", "success");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  const runNow = async (id: string) => {
    try {
      const res = await api.post<{ executionId: string }>(`/api/v1/tasks/${id}/run-now`);
      toast(`已触发运行 ${res.data.executionId}`, "info");
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  const remove = async (task: TaskItem) => {
    const ok = await confirm({
      title: `删除任务「${task.name}」？`,
      description: "删除后不可恢复，执行记录与 webhook 投递将一并移除。",
      confirmText: "确认删除",
      tone: "bad",
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/tasks/${task.id}`);
      toast("已删除任务", "success");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  return (
    <div>
      <PageHeader
        title="任务"
        subtitle={`共 ${total} 个任务 · 修改无需重启 worker，调度器下轮轮询生效`}
        actions={
          isAuthed ? (
            <Button asChild variant="primary">
              <Link href="/tasks/new">+ 新建任务</Link>
            </Button>
          ) : (
            <span className="text-[13px] text-text-muted">未登录 · 只读浏览（顶部登录可管理）</span>
          )
        }
      />

      <div className="mb-4 flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <span className="text-xs text-text-secondary">状态</span>
          <Select
            id="enabled-filter"
            value={enabledFilter}
            onValueChange={setEnabledFilter}
            className="w-32"
            options={[
              { value: "all", label: "全部" },
              { value: "true", label: "启用" },
              { value: "false", label: "禁用" },
            ]}
          />
        </div>

        {isAuthed ? (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    id="mine-only"
                    checked={mineOnly}
                    onCheckedChange={(c) => setMineOnly(c === true)}
                  />
                  <Label htmlFor="mine-only" className="cursor-pointer text-[13px]">
                    只看我的
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent>仅显示当前登录 token 所属租户的任务（同租户共享）</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex cursor-pointer items-center gap-2">
                  <Checkbox
                    id="owner-token-only"
                    checked={ownerTokenOnly}
                    onCheckedChange={(c) => setOwnerTokenOnly(c === true)}
                  />
                  <Label htmlFor="owner-token-only" className="cursor-pointer text-[13px]">
                    只看当前 api
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent>仅显示当前登录 API token 自己创建的任务</TooltipContent>
            </Tooltip>
            <div className="flex items-center gap-2">
              <Label htmlFor="system-user-filter" className="text-[13px]">系统用户</Label>
              <Input
                id="system-user-filter"
                value={systemUserFilter}
                onChange={(e) => setSystemUserFilter(e.target.value)}
                placeholder="按系统内用户筛选"
                className="w-48"
              />
            </div>
          </>
        ) : (
          <Tooltip>
            <TooltipTrigger asChild>
              <div className="flex cursor-not-allowed items-center gap-2 opacity-50">
                <Checkbox id="mine-only-disabled" checked={false} disabled />
                <Label htmlFor="mine-only-disabled" className="cursor-not-allowed text-[13px]">
                  只看我的
                </Label>
              </div>
            </TooltipTrigger>
            <TooltipContent>登录后可用</TooltipContent>
          </Tooltip>
        )}
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
        <Card className="divide-y divide-line p-0">
          {SKELETON_ROWS.map((k) => (
            <div key={k} className={cn(GRID, "px-4 py-3")}>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-16" />
              <Skeleton className="h-4 w-10" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-12" />
              <Skeleton className="h-8 w-8 justify-self-end rounded-full" />
            </div>
          ))}
        </Card>
      ) : tasks.length === 0 ? (
        <EmptyState title="暂无任务" hint="登录后点右上角「新建任务」开始" />
      ) : (
        <Card className="overflow-hidden p-0">
          <div
            className={cn(
              GRID,
              "border-b border-line bg-surface-hover/60 px-4 py-2 text-[11px] font-medium tracking-wide text-text-faint",
            )}
          >
            <span>名称</span>
            <span>调度</span>
            <span>类型</span>
            <span>下次运行</span>
            <span>状态</span>
            <span className="justify-self-end">操作</span>
          </div>
          {tasks.map((task) => (
            <div
              key={task.id}
              className={cn(
                GRID,
                "border-b border-line px-4 py-2.5 text-[13px] transition-colors last:border-b-0 hover:bg-surface-hover",
              )}
            >
              <div className="min-w-0 truncate">
                <Link
                  href={`/tasks/${task.id}`}
                  className="font-semibold text-text hover:text-accent"
                >
                  {task.name}
                </Link>
                {(task as any).systemUserId && (
                  <span className="ml-1.5 inline-flex items-center rounded-full bg-surface-hover px-1.5 py-0.5 text-[10px] font-medium text-text-faint">
                    {(task as any).systemUserId}
                  </span>
                )}
              </div>
              <div className="truncate font-mono text-xs text-text-muted">
                {scheduleLabel(task)}
              </div>
              <div>
                <Badge tone={task.taskType === "http" ? "info" : "neutral"}>{task.taskType}</Badge>
              </div>
              <div className="truncate font-mono text-xs text-text-muted">
                {task.nextRunAt ? new Date(task.nextRunAt).toLocaleString() : "—"}
              </div>
              <div>
                <Badge tone={task.enabled ? "ok" : "warn"}>{task.enabled ? "启用" : "停用"}</Badge>
              </div>
              <div className="justify-self-end">
                {task.writable ? (
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button variant="ghost" size="sm" aria-label={`操作：${task.name}`}>
                        <MoreVertical />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => runNow(task.id)}>
                        <Play /> 立即运行
                      </DropdownMenuItem>
                      <DropdownMenuItem onClick={() => toggle(task)}>
                        <Power /> {task.enabled ? "停用" : "启用"}
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem asChild>
                        <Link href={`/tasks/${task.id}/edit`}>
                          <Pencil /> 编辑
                        </Link>
                      </DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem
                        className="text-bad data-[highlighted]:bg-bad-soft"
                        onClick={() => remove(task)}
                      >
                        <Trash2 /> 删除
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                ) : (
                  <span className="text-xs text-text-faint">只读</span>
                )}
              </div>
            </div>
          ))}
        </Card>
      )}
    </div>
  );
}
