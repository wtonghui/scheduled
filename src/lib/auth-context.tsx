"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { getToken, setToken } from "./api-client";

/**
 * Web 控制台登录态上下文。
 * - 未登录（token 为空）→ 匿名只读浏览（受信网络）。
 * - 登录后 → 写操作可用，列表/详情按 token 租户隔离。
 *
 * token 存 localStorage（api-client 持久化），这里仅同步内存态 + 提供登入/登出动作。
 */

export interface AuthState {
  token: string | null;
  isAuthed: boolean;
  signIn: (token: string) => Promise<boolean>;
  signOut: () => void;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setTokenState] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);

  useEffect(() => {
    setTokenState(getToken());
    setHydrated(true);
  }, []);

  const signIn = useCallback(async (value: string): Promise<boolean> => {
    setToken(value);
    setTokenState(value);
    try {
      const who = await fetch("/api/v1/tokens/whoami", {
        headers: { "x-api-token": value },
      });
      if (!who.ok) {
        setToken(null);
        setTokenState(null);
        return false;
      }
      return true;
    } catch {
      setToken(null);
      setTokenState(null);
      return false;
    }
  }, []);

  const signOut = useCallback(() => {
    setToken(null);
    setTokenState(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ token, isAuthed: token !== null, signIn, signOut }),
    [token, signIn, signOut],
  );

  // 避免水合不一致：未挂载前渲染 null
  if (!hydrated) {
    return null;
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth must be used within AuthProvider");
  }
  return ctx;
}
