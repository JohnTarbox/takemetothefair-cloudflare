import { CheckCircle2, Sparkles, AlertTriangle } from "lucide-react";
import type { FieldConfidence } from "@/lib/url-import/types";

type Level = "high" | "medium" | "low";

const STYLES: Record<
  Level,
  { label: string; className: string; tooltip: string; Icon: typeof CheckCircle2 }
> = {
  high: {
    label: "Verified",
    className: "bg-sage-50 text-sage-700",
    tooltip: "Matched structured data (JSON-LD) or a strong signal on the page",
    Icon: CheckCircle2,
  },
  medium: {
    label: "AI extracted",
    className: "bg-amber-light text-amber-dark",
    tooltip: "AI best-guess — please review",
    Icon: Sparkles,
  },
  low: {
    label: "Missing",
    className: "bg-stone-100 text-stone-600",
    tooltip: "No value found — fill in if applicable",
    Icon: AlertTriangle,
  },
};

export function ConfidenceBadge({
  field,
  confidence,
}: {
  field: string;
  confidence: FieldConfidence;
}) {
  const level = confidence[field];
  if (!level) return null;

  const { label, className, tooltip, Icon } = STYLES[level];

  return (
    <span
      title={tooltip}
      className={`ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[11px] font-medium align-middle ${className}`}
    >
      <Icon className="w-3 h-3" aria-hidden="true" />
      {label}
    </span>
  );
}
