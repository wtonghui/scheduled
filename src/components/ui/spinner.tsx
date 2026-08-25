"use client";

import { cn } from "@/lib/cn";
import { Loader2 } from "lucide-react";

function Spinner({ className, label = "加载中…" }: { className?: string; label?: string }) {
  return (
    <div className={cn("flex items-center gap-2 py-6 text-sm text-text-muted", className)}>
      <Loader2 className="size-4 animate-spin" />
      <span className="font-mono text-xs">{label}</span>
    </div>
  );
}

export { Spinner };
