"use client";

import * as AlertDialogPrimitive from "@radix-ui/react-alert-dialog";
import * as React from "react";
import { Button } from "./button";

/**
 * 风险操作确认弹窗（替代 window.confirm）。
 * 用法：页面组件外挂 ConfirmProvider，再 useConfirm({ title, description, confirmText }) → Promise<boolean>。
 */

interface ConfirmOptions {
  title: string;
  description?: string;
  confirmText?: string;
  cancelText?: string;
  tone?: "primary" | "bad";
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = React.createContext<ConfirmFn>(() => Promise.resolve(false));

function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [opts, setOpts] = React.useState<ConfirmOptions | null>(null);
  const resolver = React.useRef<(result: boolean) => void>(() => {});

  const confirm = React.useCallback<ConfirmFn>((o) => {
    setOpts(o);
    return new Promise<boolean>((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const finish = React.useCallback((result: boolean) => {
    setOpts(null);
    resolver.current(result);
  }, []);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialogPrimitive.Root
        open={opts !== null}
        onOpenChange={(open) => {
          if (!open) finish(false);
        }}
      >
        <AlertDialogPrimitive.Portal>
          <AlertDialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40" />
          <AlertDialogPrimitive.Content className="fixed left-1/2 top-1/2 z-50 w-[92vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-line bg-surface p-5 shadow-xl">
            <AlertDialogPrimitive.Title className="text-base font-semibold text-text">
              {opts?.title}
            </AlertDialogPrimitive.Title>
            {opts?.description ? (
              <AlertDialogPrimitive.Description className="mt-2 text-sm text-text-muted">
                {opts.description}
              </AlertDialogPrimitive.Description>
            ) : null}
            <div className="mt-5 flex justify-end gap-2">
              <Button variant="secondary" size="sm" onClick={() => finish(false)}>
                {opts?.cancelText ?? "取消"}
              </Button>
              <Button
                variant={opts?.tone === "bad" ? "danger" : "primary"}
                size="sm"
                onClick={() => finish(true)}
              >
                {opts?.confirmText ?? "确认"}
              </Button>
            </div>
          </AlertDialogPrimitive.Content>
        </AlertDialogPrimitive.Portal>
      </AlertDialogPrimitive.Root>
    </ConfirmContext.Provider>
  );
}

function useConfirm(): ConfirmFn {
  return React.useContext(ConfirmContext);
}

export { ConfirmProvider, useConfirm };
