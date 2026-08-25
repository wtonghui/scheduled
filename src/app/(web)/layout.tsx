"use client";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Providers } from "@/components/ui/provider";
import { AuthProvider, useAuth } from "@/lib/auth-context";
import { cn } from "@/lib/cn";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Web 控制台外壳：浅色顶栏 + 登录态入口。
 * 未登录也直接展示内容（受信网络匿名只读浏览）；登录后可进行写操作。
 */

const NAV_ITEMS = [
  { href: "/tasks", label: "任务" },
  { href: "/docs", label: "接口文档" },
  { href: "/tokens", label: "API 令牌" },
];

function Topbar() {
  const { isAuthed, token: currentToken, signIn, signOut } = useAuth();
  const pathname = usePathname();
  const router = useRouter();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const value = draft.trim();
    if (!value) return;
    setBusy(true);
    const ok = await signIn(value);
    setBusy(false);
    if (!ok) {
      setError("token 无效：请用 APP_BOOTSTRAP_TOKEN 或已签发 token");
      return;
    }
    setDraft("");
    router.refresh();
  };

  return (
    <header className="flex items-center gap-6 border-b border-line py-4">
      <div className="font-mono text-[15px] font-bold tracking-[0.04em] text-accent">SCHEDULED</div>
      <nav className="flex items-center gap-5">
        {NAV_ITEMS.map((item) => (
          <Link
            key={item.href}
            href={item.href}
            className={cn(
              "text-[13px] transition-colors",
              pathname.startsWith(item.href)
                ? "font-medium text-text"
                : "text-text-muted hover:text-text",
            )}
          >
            {item.label}
          </Link>
        ))}
      </nav>

      <div className="ml-auto flex items-center gap-2">
        {isAuthed ? (
          <>
            <Badge
              tone="ok"
              title={
                currentToken
                  ? `当前登录的 API token（前 12 位）：${currentToken.slice(0, 12)}`
                  : undefined
              }
            >
              已登录 · {currentToken ? `${currentToken.slice(0, 12)}…` : ""}
            </Badge>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                signOut();
                router.push("/tasks");
              }}
            >
              退出
            </Button>
          </>
        ) : (
          <form onSubmit={handleSubmit} className="flex items-center gap-2">
            <Input
              id="topbar-token"
              type="password"
              value={draft}
              onChange={(e) => {
                setDraft(e.target.value);
                setError(null);
              }}
              placeholder="token 登录（可选）"
              disabled={busy}
              className="w-52 py-0 text-[13px]"
              autoComplete="off"
            />
            <Button type="submit" variant="primary" size="sm" disabled={busy}>
              {busy ? "…" : "登录"}
            </Button>
            {error && (
              <span role="alert" className="text-xs text-bad">
                {error}
              </span>
            )}
          </form>
        )}
      </div>
    </header>
  );
}

export default function WebLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <Providers>
        <div className="mx-auto min-h-screen w-full max-w-5xl px-5 pb-16">
          <Topbar />
          <main className="pt-6">{children}</main>
        </div>
      </Providers>
    </AuthProvider>
  );
}
