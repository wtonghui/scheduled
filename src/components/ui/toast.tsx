"use client";

import { cn } from "@/lib/cn";
import * as ToastPrimitive from "@radix-ui/react-toast";
import { AlertCircle, CheckCircle2, X } from "lucide-react";
import * as React from "react";

/**
 * 统一操作反馈 toast：替代各页自研的 setTimeout flash。
 * <Toaster> 提供上下文；页面用 useToast().toast("消息", "success" | "error" | "info")。
 */

export type ToastTone = "success" | "error" | "info";

interface ToastState {
  id: number;
  message: string;
  tone: ToastTone;
}

interface ToastContextValue {
  toast: (message: string, tone?: ToastTone) => void;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

let nextId = 1;

const TONE_CLASS: Record<ToastTone, string> = {
  success: "border-ok/40 bg-ok-soft text-ok",
  error: "border-bad/40 bg-bad-soft text-bad",
  info: "border-accent/40 bg-accent-soft text-accent-fg",
};

function Toaster({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = React.useState<ToastState[]>([]);

  const toast = React.useCallback((message: string, tone: ToastTone = "info") => {
    setToasts((prev) => [...prev.slice(-2), { id: nextId++, message, tone }]);
  }, []);

  const dismiss = React.useCallback((id: number) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      <ToastPrimitive.Provider swipeDirection="right">
        {toasts.map((t) => (
          <ToastPrimitive.Root
            key={t.id}
            defaultOpen
            duration={3000}
            onOpenChange={(open) => {
              if (!open) dismiss(t.id);
            }}
            className={cn(
              "fixed right-4 bottom-4 z-[80] flex items-center gap-2 rounded-md border px-4 py-3 text-sm shadow-lg data-[state=open]:animate-[toast-slide-in_150ms_ease-out]",
              TONE_CLASS[t.tone],
            )}
          >
            {t.tone === "success" ? <CheckCircle2 className="size-4 shrink-0" /> : null}
            {t.tone === "error" ? <AlertCircle className="size-4 shrink-0" /> : null}
            <ToastPrimitive.Title className="font-medium">{t.message}</ToastPrimitive.Title>
            <ToastPrimitive.Close
              className="ml-1 rounded-sm text-text-faint transition-colors hover:text-text"
              asChild
            >
              <button type="button">
                <X className="size-4" />
              </button>
            </ToastPrimitive.Close>
          </ToastPrimitive.Root>
        ))}
        <ToastPrimitive.Viewport />
      </ToastPrimitive.Provider>
    </ToastContext.Provider>
  );
}

function useToast(): ToastContextValue {
  const ctx = React.useContext(ToastContext);
  if (!ctx) {
    throw new Error("useToast 必须在 <Toaster> 内使用（provider.tsx 已挂载）");
  }
  return ctx;
}

export { Toaster, useToast };
