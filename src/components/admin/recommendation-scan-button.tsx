"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, RefreshCw } from "lucide-react";

// Hard ceiling on chunked loop iterations to prevent runaway in case the
// server returns more: true forever. 60 covers ALL_RULES.length=27 with
// the default chunk=3 (9 chunks normal) plus headroom for chunk=1 retries
// after timeouts (up to 27 chunks worst-case).
const MAX_CHUNKS = 60;

/** When a chunk times out (504/524), retry the same cursor with chunk=1
 *  to isolate the slow rule. Bounded to avoid infinite retry on a
 *  genuinely-broken rule — after this many consecutive timeouts at the
 *  same cursor, surface an error and stop. */
const MAX_RETRIES_PER_CURSOR = 2;

type PerRuleResult = {
  ruleKey: string;
  matched: number;
  inserted: number;
  refreshed: number;
  resolved: number;
  error?: string;
};

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
    perRule?: PerRuleResult[];
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

  /** Friendlier display for snake_case rule keys. */
  function formatRuleKey(k: string): string {
    return k.replace(/_/g, " ");
  }

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
    let consecutiveTimeoutsAtCursor = 0;
    let lastRetryCursor = -1;

    try {
      while (chunks < MAX_CHUNKS) {
        chunks++;

        // Auto-shrink the chunk after a timeout. Once we recover from a
        // timeout cohort, chunk reverts to undefined → server default
        // for the next cursor.
        const chunkParam = consecutiveTimeoutsAtCursor > 0 ? "&chunk=1" : "";
        const res = await fetch(`/api/admin/recommendations/scan?cursor=${cursor}${chunkParam}`, {
          method: "POST",
        });

        if (!res.ok) {
          // Auto-retry path: edge timeouts (504/524) typically mean a
          // chunk contained a single slow rule that exceeded the per-rule
          // budget on the server side AND the chunk hit the 30s edge cap
          // before the server's per-rule timer could surface a clean
          // partial result. Retry the same cursor with chunk=1 to
          // isolate the slow rule — that single rule will then trip the
          // server-side 12s per-rule timeout cleanly and be reported as
          // `failedRules: 1` so we can move on.
          if (
            (res.status === 504 || res.status === 524) &&
            consecutiveTimeoutsAtCursor < MAX_RETRIES_PER_CURSOR
          ) {
            if (cursor !== lastRetryCursor) {
              consecutiveTimeoutsAtCursor = 1;
              lastRetryCursor = cursor;
            } else {
              consecutiveTimeoutsAtCursor++;
            }
            setProgress(
              `Chunk timed out — retrying rule ${cursor + 1} alone (attempt ${
                consecutiveTimeoutsAtCursor + 1
              }/${MAX_RETRIES_PER_CURSOR + 1})…`
            );
            continue;
          }
          // Try JSON first; fall back to status + content-type sniff so we can
          // tell the user "scan timed out on the server" vs "unauthorized" etc.
          let msg = `${res.status} ${res.statusText}`;
          const contentType = res.headers.get("Content-Type") ?? "";
          if (contentType.includes("application/json")) {
            const j = (await res.json().catch(() => ({}))) as Record<string, string>;
            if (j.error) msg = j.error;
          } else if (res.status === 504 || res.status === 524) {
            msg = `Scan chunk timed out (HTTP ${res.status}) — retried twice with chunk=1 but the rule at position ${cursor + 1} never completed. Skip this rule via the admin DB or investigate.`;
          } else if (res.status === 401) {
            msg = "Session expired — reload the page and sign in again.";
          }
          setStatus({ kind: "error", text: msg });
          errored = true;
          break;
        }

        // Successful chunk — reset the timeout-retry counter.
        consecutiveTimeoutsAtCursor = 0;

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

        // Progress with the most-recently-completed rule key as
        // qualitative context alongside the quantitative count. Picks
        // the last rule in the chunk's perRule list — the order matches
        // server-side ALL_RULES order, so this is the latest one done.
        const perRule = body.data.perRule ?? [];
        const lastRule = perRule[perRule.length - 1];
        const ruleHint = lastRule
          ? lastRule.error
            ? `✗ ${formatRuleKey(lastRule.ruleKey)} failed`
            : `✓ ${formatRuleKey(lastRule.ruleKey)}`
          : "";
        setProgress(
          `${ruleHint ? ruleHint + " · " : ""}${body.data.nextCursor} of ${
            body.data.totalRules
          } rule${body.data.totalRules === 1 ? "" : "s"}${
            failedTotal > 0 ? ` · ${failedTotal} failed` : ""
          }…`
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
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-foreground bg-card border border-border rounded-md hover:bg-muted disabled:opacity-50"
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
