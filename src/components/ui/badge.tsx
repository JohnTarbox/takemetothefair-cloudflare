import { cn } from "@/lib/utils";

interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  variant?: "default" | "success" | "warning" | "danger" | "info";
  children: React.ReactNode;
}

export function Badge({ className, variant = "default", children, ...props }: BadgeProps) {
  const variants = {
    default: "bg-gray-100 text-gray-700",
    success: "bg-green-100 text-green-700",
    // UX-R3 (2026-06-07) — migrate from yellow-100/yellow-700 (~5.4:1, close to
    // the 4.5:1 AA floor) to the project's existing amber semantic tokens. The
    // amber-bg-fg token (~17:1 on amber.light) is documented at
    // tailwind.config.ts:43-54 for exactly this case: body/label text sitting on
    // an amber surface. Single edit fixes the Featured event badge at
    // event-card.tsx:137 (the PM-email-cited "Featured cards" contrast surface)
    // plus every other <Badge variant="warning"> consumer.
    warning: "bg-amber-light text-amber-bg-fg",
    danger: "bg-red-100 text-red-700",
    info: "bg-stone-100 text-navy",
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
