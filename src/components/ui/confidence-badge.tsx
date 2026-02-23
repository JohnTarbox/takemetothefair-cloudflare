import type { FieldConfidence } from "@/lib/url-import/types";

const colors = {
  high: "bg-green-500",
  medium: "bg-yellow-500",
  low: "bg-red-500",
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

  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colors[level]} ml-1`}
      title={`${level} confidence`}
    />
  );
}
