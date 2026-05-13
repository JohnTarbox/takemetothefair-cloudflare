"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

// Hard ceiling on chunked loop iterations to prevent runaway in case the
// server returns more: true forever. 50 is well above the ALL_RULES.length
// of 23 even with a chunk size of 1.
const MAX_CHUNKS = 50;

type ChunkResponse = {
  success: boolean;
  data?: {
    scannedRules: number;
    inserted: number;
    refreshed: number;
    resolved: number;
    failedRules: number;
    cursor: number;
    nextCursor: number;
    more: boolean;
    totalRules: number;
  };
  error?: string;
};

export function RecommendationScanButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function scan() {
    setBusy(true);
    setError(null);
    setProgress("Scanning…");

    let cursor = 0;
    let chunks = 0;
    const totals = { failedRules: 0, scannedRules: 0 };

    try {
      while (chunks < MAX_CHUNKS) {
        chunks++;
        const res = await fetch(`/api/admin/recommendations/scan?cursor=${cursor}`, {
          method: "POST",
        });

        if (!res.ok) {
          // Try JSON first; fall back to status + content-type sniff so we can
          // tell the user "scan timed out on the server" vs "unauthorized" etc.
          let msg = `${res.status} ${res.statusText}`;
          const contentType = res.headers.get("Content-Type") ?? "";
          if (contentType.includes("application/json")) {
            const j = (await res.json().catch(() => ({}))) as Record<string, string>;
            if (j.error) msg = j.error;
          } else if (res.status === 504 || res.status === 524) {
            msg = `Scan chunk timed out (HTTP ${res.status}). Partial progress saved; click again to continue from cursor ${cursor}.`;
          }
          setError(msg);
          break;
        }

        const body = (await res.json()) as ChunkResponse;
        if (!body.success || !body.data) {
          setError(body.error ?? "Scan returned unexpected shape");
          break;
        }

        totals.scannedRules += body.data.scannedRules;
        totals.failedRules += body.data.failedRules ?? 0;
        cursor = body.data.nextCursor;
        setProgress(
          `Scanned ${body.data.nextCursor} of ${body.data.totalRules} rule${
            body.data.totalRules === 1 ? "" : "s"
          }${totals.failedRules > 0 ? ` · ${totals.failedRules} failed` : ""}…`
        );
        if (!body.data.more) break;
      }
    } catch {
      setError("Network error mid-scan");
    } finally {
      setBusy(false);
      setProgress(null);
      router.refresh();
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
        {busy ? (progress ?? "Scanning…") : "Re-scan rules"}
      </button>
      {error && <span className="text-xs text-red-700">{error}</span>}
    </div>
  );
}
