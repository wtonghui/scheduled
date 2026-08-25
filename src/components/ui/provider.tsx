"use client";

import { ConfirmProvider } from "./alert-dialog";
import { Toaster } from "./toast";
import { TooltipProvider } from "./tooltip";

/** 全局 UI provider 组合：Tooltip / 确认弹窗 / Toast。挂载在 (web)/layout。 */
function Providers({ children }: { children: React.ReactNode }) {
  return (
    <TooltipProvider>
      <ConfirmProvider>
        <Toaster>{children}</Toaster>
      </ConfirmProvider>
    </TooltipProvider>
  );
}

export { Providers };
