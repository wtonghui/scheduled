import { cn } from "@/lib/cn";

function EmptyState({
  title,
  hint,
  className,
  children,
}: { title: string; hint?: string; className?: string; children?: React.ReactNode }) {
  return (
    <div
      className={cn(
        "rounded-lg border border-dashed border-line-strong bg-surface px-6 py-12 text-center",
        className,
      )}
    >
      <p className="text-sm font-medium text-text-secondary">{title}</p>
      {hint ? <p className="mt-1 text-xs text-text-muted">{hint}</p> : null}
      {children ? <div className="mt-4 flex justify-center">{children}</div> : null}
    </div>
  );
}

export { EmptyState };
