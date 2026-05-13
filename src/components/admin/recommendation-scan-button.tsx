"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

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

// Status message after a scan completes (success or with caught per-rule
// failures). Persists in the UI alongside the button so the operator doesn't
// have to compare timestamps to know the click did something.
type Status =
  | { kind: "ok"; text: string }
  | { kind: "warn"; text: string }
  | { kind: "error"; text: string };

export function RecommendationScanButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);

  async function scan() {
    setBusy(true);
    setStatus(null);
    setProgress("Scanning…");

    let cursor = 0;
    let chunks = 0;
    let scannedTotal = 0;
    let failedTotal = 0;
    let totalRules = 0;
    let errored = false;

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
            msg = `Scan chunk timed out (HTTP ${res.status}). Partial progress saved; click again to continue from rule ${cursor}.`;
          } else if (res.status === 401) {
            msg = "Session expired — reload the page and sign in again.";
          }
          setStatus({ kind: "error", text: msg });
          errored = true;
          break;
        }

        const body = (await res.json()) as ChunkResponse;
        if (!body.success || !body.data) {
          setStatus({ kind: "error", text: body.error ?? "Scan returned unexpected shape" });
          errored = true;
          break;
        }

        scannedTotal += body.data.scannedRules;
        failedTotal += body.data.failedRules ?? 0;
        totalRules = body.data.totalRules;
        cursor = body.data.nextCursor;
        setProgress(
          `Scanned ${body.data.nextCursor} of ${body.data.totalRules} rule${
            body.data.totalRules === 1 ? "" : "s"
          }${failedTotal > 0 ? ` · ${failedTotal} failed` : ""}…`
        );
        if (!body.data.more) break;
      }

      if (!errored) {
        if (failedTotal > 0) {
          setStatus({
            kind: "warn",
            text: `Scanned ${scannedTotal} of ${totalRules} rules · ${failedTotal} rule${
              failedTotal === 1 ? "" : "s"
            } failed (see banner above for details).`,
          });
        } else {
          setStatus({
            kind: "ok",
            text: `Scanned ${scannedTotal} of ${totalRules} rules · all green.`,
          });
        }
      }
    } catch {
      setStatus({ kind: "error", text: "Network error mid-scan — page state may be stale." });
    } finally {
      setBusy(false);
      setProgress(null);
      router.refresh();
    }
  }

  const statusIcon =
    status?.kind === "ok" ? (
      <CheckCircle2 className="w-4 h-4 text-green-700 shrink-0" aria-hidden="true" />
    ) : status?.kind === "warn" ? (
      <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0" aria-hidden="true" />
    ) : status?.kind === "error" ? (
      <AlertTriangle className="w-4 h-4 text-red-700 shrink-0" aria-hidden="true" />
    ) : null;
  const statusColor =
    status?.kind === "ok"
      ? "text-green-800"
      : status?.kind === "warn"
        ? "text-amber-800"
        : status?.kind === "error"
          ? "text-red-800"
          : "";

  return (
    <div className="inline-flex items-center gap-3 flex-wrap">
      <button
        type="button"
        onClick={scan}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
      >
        <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
        {busy ? (progress ?? "Scanning…") : "Re-scan rules"}
      </button>
      {status && (
        <span
          role={status.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          className={`inline-flex items-center gap-1.5 text-sm ${statusColor}`}
        >
          {statusIcon}
          <span>{status.text}</span>
        </span>
      )}
    </div>
  );
}
