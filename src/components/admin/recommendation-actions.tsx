"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

type Action = "snooze7" | "snooze30" | "forever" | "acted";

const LABELS: Record<Action, string> = {
  snooze7: "Snooze 7d",
  snooze30: "Snooze 30d",
  forever: "Dismiss forever",
  acted: "Mark done",
};

export function RecommendationActions({ itemId }: { itemId: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState<Action | null>(null);

  async function go(action: Action) {
    setBusy(action);
    try {
      const body =
        action === "acted"
          ? { itemId, days: null, acted: true }
          : action === "forever"
            ? { itemId, days: null }
            : { itemId, days: action === "snooze7" ? 7 : 30 };
      const res = await fetch("/api/admin/recommendations/dismiss", {
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

  return (
    <div className="flex flex-wrap gap-1.5 text-xs">
      {(Object.keys(LABELS) as Action[]).map((a) => (
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
            a === "acted"
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
