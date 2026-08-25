"use client";

import { cn } from "@/lib/cn";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as React from "react";

const Label = React.forwardRef<
  React.ElementRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(({ className, ...props }, ref) => (
  <LabelPrimitive.Root
    ref={ref}
    className={cn("block text-xs font-medium text-text-secondary", className)}
    {...props}
  />
));
Label.displayName = "Label";

export { Label };
