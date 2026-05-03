"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

export function RecommendationScanButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/recommendations/scan", { method: "POST" });
      if (res.ok) {
        router.refresh();
      } else {
        const data = (await res.json().catch(() => ({}))) as Record<string, string>;
        setError(data.error ?? res.statusText);
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-3">
      <button
        type="button"
        onClick={scan}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
      >
        <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Scanning…" : "Re-scan rules"}
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
