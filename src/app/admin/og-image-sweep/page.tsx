"use client";

/**
 * Admin UI for the og:image sweep — analyst Item 13 Phase 2a operator
 * page. Wraps POST /api/admin/og-image/sweep so admin can preview and
 * apply 10-event batches via the browser without needing the
 * INTERNAL_API_KEY in a shell.
 *
 * The sweep itself is capped at 10 events per call to fit inside
 * Cloudflare's 30s response budget (each event = source-URL fetch +
 * HEAD + Range probe + optional GET + R2 PUT). At ~900 imageless
 * events that's ~90 clicks if all succeed; in practice many will
 * skip on aggregator filter / no og:image / dimension gate, so the
 * "would_update" yield per batch is the more interesting number.
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const runtime = "edge";

interface ProgressResponse {
  remaining: number;
  /** Imageless events that the sweep already attempted at least once
   *  and skipped (no og:image, dead URL, dimension reject, etc.). These
   *  won't be re-selected by Apply batch — they need Phase 2b's web-
   *  search fallback or a manual upload to become non-imageless. */
  attemptedSkipped?: number;
  totalApproved: number;
  pctImageless: number | null;
}

interface Outcome {
  event_id: string;
  source_url: string;
  outcome: string;
  image_url?: string;
  reason?: string;
}

interface SweepResponse {
  summary: {
    apply: boolean;
    scanned: number;
    updated: number;
    would_update: number;
    skipped: number;
    by_outcome: Record<string, number>;
  };
  outcomes: Outcome[];
}

const ENDPOINT = "/api/admin/og-image/sweep";

export default function OgImageSweepPage() {
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [result, setResult] = useState<SweepResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadProgress = useCallback(async () => {
    try {
      const res = await fetch(ENDPOINT);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ProgressResponse;
      setProgress(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadProgress();
  }, [loadProgress]);

  const run = useCallback(
    async (apply: boolean, limit: number) => {
      setLoading(true);
      setError(null);
      try {
        const url = `${ENDPOINT}?apply=${apply}&limit=${limit}`;
        const res = await fetch(url, { method: "POST" });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        const data = (await res.json()) as SweepResponse;
        setResult(data);
        if (apply) await loadProgress();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [loadProgress]
  );

  const done = progress?.remaining === 0;

  return (
    <div className="max-w-5xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-foreground">og:image sweep</h1>
        <p className="text-sm text-muted-foreground mt-1">
          Fills <code>events.image_url</code> for APPROVED events with no image by extracting the
          source page&apos;s <code>og:image</code> and re-hosting in R2. Phase 2a gates: real
          JPEG/PNG/WebP dimension parsing (≥600px long edge), logo down-rank, junk-URL pre-filter.
          Capped at 10 events per call to fit the 30s response budget.
        </p>
      </header>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-foreground">Progress</h2>
        </CardHeader>
        <CardContent>
          {progress == null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="flex items-center gap-6 flex-wrap">
              <div>
                <p className="text-3xl font-bold text-foreground tabular-nums">
                  {progress.remaining.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">never-attempted candidates</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-foreground tabular-nums">
                  {(progress.attemptedSkipped ?? 0).toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">attempted &amp; skipped</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-foreground tabular-nums">
                  {progress.totalApproved.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">total APPROVED events</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-foreground tabular-nums">
                  {progress.pctImageless == null ? "—" : `${progress.pctImageless}%`}
                </p>
                <p className="text-xs text-muted-foreground">imageless</p>
              </div>
              {done && <Badge variant="success">Done</Badge>}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="font-semibold text-foreground">Actions</h2>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={() => run(false, 10)}
            >
              Preview (10 events, dry-run)
            </Button>
            <Button type="button" disabled={loading || done} onClick={() => run(true, 10)}>
              Apply batch (10 events)
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={loading}
              onClick={() => void loadProgress()}
            >
              Refresh progress
            </Button>
          </div>
          {loading && (
            <p className="text-sm text-muted-foreground mt-3">
              Running… can take 20-30s while each source page is fetched.
            </p>
          )}
          {error && (
            <p className="text-sm text-red-600 mt-3" role="alert">
              {error}
            </p>
          )}
        </CardContent>
      </Card>

      {result && (
        <Card>
          <CardHeader>
            <h2 className="font-semibold text-foreground">
              Last run {result.summary.apply ? "(applied)" : "(dry-run)"}
            </h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Stat label="Scanned" value={result.summary.scanned} />
              <Stat
                label={result.summary.apply ? "Updated" : "Would update"}
                value={result.summary.apply ? result.summary.updated : result.summary.would_update}
              />
              <Stat label="Skipped" value={result.summary.skipped} />
              <Stat
                label="Yield"
                value={Math.round(
                  ((result.summary.apply ? result.summary.updated : result.summary.would_update) /
                    Math.max(1, result.summary.scanned)) *
                    100
                )}
                suffix="%"
              />
            </div>

            {Object.keys(result.summary.by_outcome).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-2">By outcome</h3>
                <ul className="text-sm text-foreground space-y-1">
                  {Object.entries(result.summary.by_outcome)
                    .sort((a, b) => b[1] - a[1])
                    .map(([outcome, count]) => (
                      <li key={outcome} className="flex justify-between max-w-md">
                        <span className="font-mono">{outcome}</span>
                        <span className="tabular-nums">{count}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {result.outcomes.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-2">Per-event detail</h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="py-2 pr-3">outcome</th>
                        <th className="py-2 pr-3">source_url</th>
                        <th className="py-2 pr-3">image / reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.outcomes.map((row) => (
                        <tr key={row.event_id} className="border-b border-border">
                          <td className="py-2 pr-3">
                            <OutcomeBadge outcome={row.outcome} />
                          </td>
                          <td className="py-2 pr-3 font-mono text-foreground max-w-[300px] truncate">
                            <a
                              href={row.source_url}
                              target="_blank"
                              rel="noopener noreferrer"
                              className="text-blue-600 hover:underline"
                            >
                              {row.source_url || <span className="text-muted-foreground">—</span>}
                            </a>
                          </td>
                          <td className="py-2 pr-3 font-mono text-foreground max-w-[420px] truncate">
                            {row.image_url ? (
                              <a
                                href={row.image_url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-blue-600 hover:underline"
                              >
                                {row.image_url}
                              </a>
                            ) : (
                              (row.reason ?? <span className="text-muted-foreground">—</span>)
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Stat({ label, value, suffix }: { label: string; value: number; suffix?: string }) {
  return (
    <div>
      <p className="text-2xl font-bold text-foreground tabular-nums">
        {value.toLocaleString()}
        {suffix}
      </p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}

function OutcomeBadge({ outcome }: { outcome: string }) {
  const variant: "success" | "warning" | "danger" | "default" =
    outcome === "updated" || outcome === "would_update"
      ? "success"
      : outcome.startsWith("skipped_")
        ? "warning"
        : "default";
  return <Badge variant={variant}>{outcome}</Badge>;
}
