"use client";

import { cn } from "@/lib/cn";
import { type VariantProps, cva } from "class-variance-authority";
import type * as React from "react";

const badgeVariants = cva(
  "inline-flex items-center whitespace-nowrap rounded-pill border px-2 py-0.5 font-mono text-[11px] leading-4",
  {
    variants: {
      tone: {
        neutral: "border-line-strong bg-surface text-text-muted",
        ok: "border-ok/30 bg-ok-soft text-ok",
        warn: "border-warn/30 bg-warn-soft text-warn",
        bad: "border-bad/30 bg-bad-soft text-bad",
        info: "border-info/30 bg-info-soft text-info",
      },
    },
    defaultVariants: {
      tone: "neutral",
    },
  },
);

interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, tone, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ tone }), className)} {...props} />;
}

export { Badge, badgeVariants };
