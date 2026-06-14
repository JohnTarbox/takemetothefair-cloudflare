"use client";

/**
 * REL4 IndexNow kill-switch toggle for /admin/analytics?tab=indexnow.
 *
 * Reflects + flips the `indexnow:paused` KV flag that pingIndexNow's circuit
 * breaker honors. Paused = no path contacts Bing (deferred enqueues still
 * queue). Resuming is the consequential direction — during an active Bing
 * penalty it can re-trip the rate limit — so we confirm before un-pausing.
 */

import { useCallback, useEffect, useState } from "react";
import { Loader2, ShieldAlert, ShieldCheck } from "lucide-react";

type PauseState = { paused: boolean; note: string | null; kvAvailable: boolean };

export function IndexNowKillSwitchToggle() {
  const [state, setState] = useState<PauseState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/indexnow/pause", { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setState((await res.json()) as PauseState);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = useCallback(async () => {
    if (!state || busy) return;
    const next = !state.paused;
    // Confirm the risky direction: turning the switch OFF resumes Bing pings.
    if (!next) {
      const ok = window.confirm(
        "Resume IndexNow pings?\n\nThis clears the kill-switch and lets every write path contact Bing again. " +
          "If Bing's per-host penalty hasn't decayed yet, this can re-trip the 429 rate limit. " +
          "Only resume after a sustained quiet window."
      );
      if (!ok) return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/indexnow/pause", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ paused: next }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
        throw new Error(body.message ?? body.error ?? `HTTP ${res.status}`);
      }
      setState((await res.json()) as PauseState);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to update");
    } finally {
      setBusy(false);
    }
  }, [state, busy]);

  // Loading skeleton — keep the row height stable.
  if (!state) {
    return (
      <span className="inline-flex items-center gap-2 rounded-full border border-border px-3 py-1.5 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {error ? "Kill-switch unavailable" : "Loading kill-switch…"}
      </span>
    );
  }

  const paused = state.paused;

  return (
    <span className="inline-flex items-center gap-2">
      <button
        type="button"
        onClick={toggle}
        disabled={busy}
        aria-pressed={paused}
        title={
          state.note
            ? `IndexNow kill-switch ${paused ? "ON (paused)" : "OFF (live)"} — ${state.note}`
            : `IndexNow kill-switch ${paused ? "ON (paused)" : "OFF (live)"}`
        }
        className={
          "inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-sm font-medium transition-colors disabled:opacity-60 " +
          (paused
            ? "border-red-300 bg-red-50 text-red-700 hover:bg-red-100"
            : "border-emerald-300 bg-emerald-50 text-emerald-700 hover:bg-emerald-100")
        }
      >
        {busy ? (
          <Loader2 className="h-4 w-4 animate-spin" />
        ) : paused ? (
          <ShieldAlert className="h-4 w-4" />
        ) : (
          <ShieldCheck className="h-4 w-4" />
        )}
        {/* The visual switch */}
        <span
          aria-hidden
          className={
            "relative inline-block h-4 w-7 rounded-full transition-colors " +
            (paused ? "bg-red-500" : "bg-emerald-500")
          }
        >
          <span
            className={
              "absolute top-0.5 h-3 w-3 rounded-full bg-white transition-all " +
              (paused ? "left-3.5" : "left-0.5")
            }
          />
        </span>
        Pings {paused ? "paused" : "live"}
      </button>
      {error && <span className="text-xs text-red-600">{error}</span>}
    </span>
  );
}
