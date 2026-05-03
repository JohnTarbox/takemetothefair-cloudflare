"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

type RunResult = {
  inspected: number;
  newIssues: number;
  resolvedIssues: number;
  skipped: number;
  errors: string[];
};

export function SiteHealthSweepButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<RunResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function runOne() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/site-health/sweep?batchSize=200", { method: "POST" });
      const data = (await res.json()) as { success: boolean; data?: RunResult; error?: string };
      if (!res.ok || !data.success) {
        setError(data.error ?? res.statusText);
      } else if (data.data) {
        setLast(data.data);
        router.refresh();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-3 flex-wrap">
      <button
        type="button"
        onClick={runOne}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
      >
        <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
        {busy ? "Running…" : "Run URL Inspection sweep (one batch)"}
      </button>
      {last && !error && (
        <span className="text-xs text-gray-600">
          Last batch: inspected {last.inspected}, new {last.newIssues}, resolved{" "}
          {last.resolvedIssues}
          {last.errors.length > 0 && `, ${last.errors.length} errors`}
        </span>
      )}
      {error && <span className="text-xs text-red-700">Error: {error}</span>}
    </div>
  );
}
