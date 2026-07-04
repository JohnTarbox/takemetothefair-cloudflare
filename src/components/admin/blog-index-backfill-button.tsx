"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";

type ChunkResult = {
  ok?: boolean;
  total?: number;
  processed?: number;
  cursor?: number;
  nextCursor?: number | null;
  done?: boolean;
  errors?: number;
  error?: string;
  message?: string;
};

/**
 * OPE-94 — walks POST /api/admin/blog-index-backfill in bounded chunks,
 * following `nextCursor` until `done`, seeding every published blog URL into
 * gsc_inspection_state + bing_inspection_state. Shows live progress and a
 * final "Done: N seeded (M errors)". Reads each response as text first so a
 * non-JSON edge response (HTML 504, empty body) surfaces cleanly instead of a
 * misleading JSON.parse error.
 */
export function BlogIndexBackfillButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function run() {
    setBusy(true);
    setError(null);
    setDone(null);
    setProgress("Backfilling…");

    let cursor = 0;
    let processed = 0;
    let errors = 0;
    let total = 0;

    try {
      for (;;) {
        const res = await fetch(`/api/admin/blog-index-backfill?cursor=${cursor}&chunk=15`, {
          method: "POST",
        });
        const raw = await res.text();
        let data: ChunkResult | null = null;
        try {
          data = JSON.parse(raw) as ChunkResult;
        } catch {
          setError(
            `HTTP ${res.status}: ${raw.slice(0, 200) || res.statusText || "empty response"}`
          );
          setProgress(null);
          router.refresh();
          return;
        }
        if (!res.ok || !data.ok) {
          setError(data.error ?? data.message ?? `HTTP ${res.status}: ${res.statusText}`);
          setProgress(null);
          router.refresh();
          return;
        }

        processed += data.processed ?? 0;
        errors += data.errors ?? 0;
        total = data.total ?? total;
        setProgress(`Backfilling… ${processed}/${total}`);

        if (data.done || data.nextCursor == null) break;
        cursor = data.nextCursor;
      }

      setDone(`Done: ${processed} seeded${errors > 0 ? ` (${errors} errors)` : ""}`);
      setProgress(null);
      router.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Network error");
      setProgress(null);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="inline-flex items-center gap-3 flex-wrap">
      <button
        type="button"
        onClick={run}
        disabled={busy}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-foreground bg-card border border-border rounded-md hover:bg-muted disabled:opacity-50"
      >
        <RefreshCw className={`w-4 h-4 ${busy ? "animate-spin" : ""}`} />
        Backfill index status (Google + Bing)
      </button>
      {busy && progress && <span className="text-xs text-muted-foreground">{progress}</span>}
      {!busy && done && !error && <span className="text-xs text-muted-foreground">{done}</span>}
      {error && <span className="text-xs text-red-700">Error: {error}</span>}
    </div>
  );
}
