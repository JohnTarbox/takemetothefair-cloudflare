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
      // batchSize=8 is empirically inside Cloudflare's 30s request budget
      // (each URL Inspection call is ~3-5s). Larger batches (the old 200
      // default) timed out and Cloudflare returned an HTML 504 — which the
      // old client-side res.json() then failed to parse, masking the real
      // problem.
      const res = await fetch("/api/admin/site-health/sweep?batchSize=8", { method: "POST" });
      // Read as text first so we can surface non-JSON responses (HTML 504s,
      // empty bodies, edge redirects) instead of a misleading "JSON.parse
      // unexpected character" error.
      const raw = await res.text();
      let data: { success?: boolean; data?: RunResult; error?: string } | null = null;
      try {
        data = JSON.parse(raw);
      } catch {
        // Non-JSON response — show what we got.
        setError(`HTTP ${res.status}: ${raw.slice(0, 200) || res.statusText || "empty response"}`);
        // Refresh anyway since some URLs may have been persisted before
        // the timeout fired.
        router.refresh();
        return;
      }
      if (!res.ok || !data?.success) {
        setError(data?.error ?? `HTTP ${res.status}: ${res.statusText}`);
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
