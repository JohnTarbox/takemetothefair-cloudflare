"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type BulkAction = "bulk_snooze30" | "bulk_acted";

const LABELS: Record<BulkAction, string> = {
  bulk_snooze30: "Snooze all 30d",
  bulk_acted: "Mark all done",
};

const CONFIRM: Record<BulkAction, string> = {
  bulk_snooze30:
    "Snooze ALL active items in this rule for 30 days? They'll re-surface after 30d if still matching.",
  bulk_acted:
    "Mark ALL active items in this rule as done? They drop out of the active list permanently (until manually undone or the entity drifts back into matching).",
};

export function RecommendationBulkActions({
  ruleId,
  itemCount,
}: {
  ruleId: string;
  itemCount: number;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<BulkAction | null>(null);

  async function go(action: BulkAction) {
    if (!confirm(CONFIRM[action])) return;

    setBusy(action);
    try {
      const body =
        action === "bulk_acted"
          ? { ruleId, action: "acted" as const, days: null }
          : { ruleId, action: "dismiss" as const, days: 30 };
      const res = await fetch("/api/admin/recommendations/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        router.refresh();
      } else {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        alert(`Failed: ${data.error ?? res.statusText}`);
      }
    } catch {
      alert("Network error — please try again.");
    } finally {
      setBusy(null);
    }
  }

  // Only show bulk buttons when there's a meaningful number of items;
  // single-item rules don't benefit and the buttons add visual noise.
  if (itemCount < 3) return null;

  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {(Object.keys(LABELS) as BulkAction[]).map((a) => (
        <button
          key={a}
          type="button"
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            go(a);
          }}
          disabled={busy !== null}
          className={`px-2 py-1 rounded border ${
            a === "bulk_acted"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
              : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
          } disabled:opacity-50`}
        >
          {busy === a ? "…" : LABELS[a]}
        </button>
      ))}
    </div>
  );
}
