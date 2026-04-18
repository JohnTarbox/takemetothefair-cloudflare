import type { ReactNode } from "react";
import { Info, AlertTriangle, CheckCircle2, Lightbulb } from "lucide-react";
import { cn } from "@/lib/utils";

type CalloutType = "info" | "warning" | "success" | "tip";

interface CalloutProps {
  type?: CalloutType;
  title?: string;
  children?: ReactNode;
}

const variants: Record<
  CalloutType,
  { wrap: string; icon: typeof Info; iconColor: string; title: string }
> = {
  info: {
    wrap: "bg-brand-blue-light/60 border-royal/30",
    icon: Info,
    iconColor: "text-royal",
    title: "text-navy",
  },
  warning: {
    wrap: "bg-amber-light/60 border-warning/30",
    icon: AlertTriangle,
    iconColor: "text-warning",
    title: "text-amber-dark",
  },
  success: {
    wrap: "bg-sage-50 border-sage-700/30",
    icon: CheckCircle2,
    iconColor: "text-success",
    title: "text-sage-700",
  },
  tip: {
    wrap: "bg-terracotta-light/60 border-terracotta/30",
    icon: Lightbulb,
    iconColor: "text-terracotta",
    title: "text-stone-900",
  },
};

export function Callout({ type = "info", title, children }: CalloutProps) {
  const v = variants[type] ?? variants.info;
  const Icon = v.icon;
  return (
    <div className={cn("not-prose my-6 flex gap-3 rounded-xl border px-4 py-3", v.wrap)}>
      <Icon className={cn("mt-0.5 h-5 w-5 flex-shrink-0", v.iconColor)} aria-hidden />
      <div className="flex-1 text-sm text-stone-900">
        {title && <div className={cn("mb-1 font-semibold", v.title)}>{title}</div>}
        <div className="[&>p]:my-1 [&>p:first-child]:mt-0 [&>p:last-child]:mb-0">{children}</div>
      </div>
    </div>
  );
}
