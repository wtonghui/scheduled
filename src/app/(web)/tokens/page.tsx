"use client";

import { useConfirm } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { CopyButton } from "@/components/ui/copy-button";
import { EmptyState } from "@/components/ui/empty-state";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PageHeader } from "@/components/ui/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/components/ui/toast";
import { ApiClientError, api } from "@/lib/api-client";
import { useAuth } from "@/lib/auth-context";
import { useCallback, useEffect, useState } from "react";

/**
 * Token 管理控制台（contracts T1-T3）。签发免登录（单默认租户临时约定）；列表/吊销需登录。
 */

interface TokenRow {
  id: string;
  prefix: string;
  lastFour: string;
  name: string | null;
  scopes: string[];
  revokedAt: string | null;
  lastUsedAt: string | null;
  expiresAt: string | null;
  createdAt: string;
}

const SKELETON_ROWS = ["sk-1", "sk-2", "sk-3"];

export default function TokensPage() {
  const { isAuthed } = useAuth();
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [scopes, setScopes] = useState("tasks:read,tasks:write,tokens:manage");
  const [created, setCreated] = useState<string | null>(null);
  const { toast } = useToast();
  const confirm = useConfirm();

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const { data } = await api.get<TokenRow[]>("/api/v1/tokens");
      setTokens(data);
    } catch (err) {
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isAuthed) load();
  }, [isAuthed, load]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCreated(null);
    try {
      const res = await api.post<{ token: string }>("/api/v1/tokens", {
        name: name || undefined,
        scopes: scopes
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      });
      setCreated(res.data.token);
      setName("");
      setShowCreate(false);
      if (isAuthed) load();
      toast("token 已创建（明文仅显示一次）", "success");
    } catch (err) {
      setError(err instanceof ApiClientError ? `${err.status} ${err.message}` : String(err));
    }
  };

  const revoke = async (id: string) => {
    const ok = await confirm({
      title: "吊销此 token？",
      description: "吊销后该 token 立即失效，且不可恢复。",
      confirmText: "确认吊销",
      cancelText: "取消",
      tone: "bad",
    });
    if (!ok) return;
    try {
      await api.del(`/api/v1/tokens/${id}`);
      toast("已吊销 token", "success");
      load();
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : String(err));
    }
  };

  return (
    <div>
      <PageHeader
        title="API 令牌"
        subtitle="签发无需登录（单默认租户临时约定，明文仅返回一次）；列表与吊销需登录。数据库只存 SHA-256 哈希。"
        actions={
          <Button
            variant={showCreate ? "secondary" : "primary"}
            onClick={() => setShowCreate((v) => !v)}
          >
            {showCreate ? "取消" : "+ 新建令牌"}
          </Button>
        }
      />

      {showCreate && (
        <form onSubmit={create} className="mb-6">
          <Card className="max-w-lg p-4">
            <div className="space-y-4">
              <div>
                <Label htmlFor="token-name">名称（可选）</Label>
                <Input
                  id="token-name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="ops-laptop"
                  className="mt-1.5"
                />
              </div>
              <div>
                <Label htmlFor="token-scopes">权限范围（逗号分隔）</Label>
                <Input
                  id="token-scopes"
                  value={scopes}
                  onChange={(e) => setScopes(e.target.value)}
                  className="mt-1.5 font-mono text-xs"
                />
              </div>
              {error && (
                <div
                  role="alert"
                  className="rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
                >
                  {error}
                </div>
              )}
              <Button type="submit" variant="primary" size="sm">
                创建
              </Button>
            </div>
          </Card>
        </form>
      )}

      {created && (
        <Card className="mb-6 border-accent/40 bg-accent-soft p-4">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
            <div className="text-sm font-semibold text-accent-fg">明文 token（仅此一次）</div>
            <CopyButton value={created} />
          </div>
          <pre className="max-h-32 select-all overflow-x-auto rounded-md border border-accent/30 bg-surface p-3 font-mono text-xs text-text">
            {created}
          </pre>
          <p className="mt-2 text-xs text-text-muted">请立即复制并妥善保存，关闭后无法再次查看。</p>
        </Card>
      )}

      {error && !showCreate && (
        <div
          role="alert"
          className="mb-4 rounded-md border border-bad/40 bg-bad-soft px-3 py-2 text-[13px] text-bad"
        >
          {error}
        </div>
      )}

      {!isAuthed ? (
        <EmptyState
          title="未登录"
          hint="可匿名签发 token（上方「新建令牌」）；列表与吊销需登录后查看。"
        />
      ) : loading ? (
        <Card className="divide-y divide-line p-0">
          {SKELETON_ROWS.map((k) => (
            <div key={k} className="flex items-center gap-4 px-4 py-3">
              <Skeleton className="h-4 w-32" />
              <Skeleton className="h-4 w-24" />
              <Skeleton className="h-4 w-28" />
              <Skeleton className="h-4 w-16" />
            </div>
          ))}
        </Card>
      ) : tokens.length === 0 ? (
        <EmptyState title="暂无 token" hint="点右上角「新建令牌」创建一个" />
      ) : (
        <Card className="overflow-hidden p-0">
          <div className="overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead>
                <tr className="border-b border-line text-left text-[11px] tracking-wide text-text-faint">
                  <th className="px-4 py-2 font-medium">标识</th>
                  <th className="px-4 py-2 font-medium">名称</th>
                  <th className="px-4 py-2 font-medium">权限范围</th>
                  <th className="px-4 py-2 font-medium">最近使用</th>
                  <th className="px-4 py-2 font-medium">状态</th>
                  <th className="px-4 py-2 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {tokens.map((t) => (
                  <tr
                    key={t.id}
                    className="border-b border-line last:border-b-0 hover:bg-surface-hover"
                  >
                    <td className="px-4 py-2.5 font-mono text-xs text-text-muted">
                      {t.prefix}…{t.lastFour}
                    </td>
                    <td className="px-4 py-2.5">{t.name ?? "—"}</td>
                    <td className="px-4 py-2.5">
                      <div className="flex flex-wrap gap-1">
                        {t.scopes.map((s) => (
                          <Badge key={s} tone="neutral">
                            {s}
                          </Badge>
                        ))}
                      </div>
                    </td>
                    <td className="px-4 py-2.5 text-xs text-text-muted">
                      {t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : "从未使用"}
                    </td>
                    <td className="px-4 py-2.5">
                      <Badge tone={t.revokedAt ? "bad" : "ok"}>
                        {t.revokedAt ? "已吊销" : "活跃"}
                      </Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {!t.revokedAt && (
                        <Button variant="danger" size="sm" onClick={() => revoke(t.id)}>
                          吊销
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}
