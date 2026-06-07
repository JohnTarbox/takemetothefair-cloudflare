import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "warning" | "danger" | "info";
  children: React.ReactNode;
}

export function Badge({ className, variant = "default", children, ...props }: BadgeProps) {
  // Design System keystone PR 2 (2026-06-07) — token migration.
  // Variants now consume soft status tokens (--success-soft etc.) so
  // PR 4's dark theme can recolor the entire pill family in one place.
  // The base classes ENFORCE `text-xs` (12px minimum) — this kills the
  // 15 cataloged `text-[10px]` instances downstream by primitive cascade,
  // closing the M2 date-badge legibility issue without per-callsite edits.
  // UX-R3's amber-bg-fg pair lives in --warning-soft / --warning-soft-foreground
  // (defined in PR 1 + PR 2's globals.css; ~17:1 AAA contrast on the pill).
  const variants = {
    default: "bg-muted text-foreground",
    success: "bg-success-soft text-success-soft-foreground",
    warning: "bg-warning-soft text-warning-soft-foreground",
    danger: "bg-danger-soft text-danger-soft-foreground",
    info: "bg-info-soft text-info-soft-foreground",
  };

  return (
    <span
      className={cn(
        "inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium",
        variants[variant],
        className
      )}
      {...props}
    >
      {children}
    </span>
  );
}
