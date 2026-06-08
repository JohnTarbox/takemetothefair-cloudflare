"use client";

/**
 * One-off admin UI to drive the source_domain + ingestion_method backfill
 * shipped with drizzle/0090 (analyst 2026-05-26 backlog Item 1). Wraps
 * POST /api/admin/backfill/source-domain so an admin can preview and
 * apply batches via the browser (session-cookie auth) without needing
 * the INTERNAL_API_KEY in a shell.
 *
 * Buttons:
 *   - Preview (apply=false, limit=20) — dry-run with sample
 *   - Apply batch (apply=true, limit=500) — commits up to 500 rows
 *
 * The page also surfaces GET / progress so the admin knows how many
 * rows remain and can pace runs without re-checking via D1. Once the
 * backlog reaches zero the page reads as "Done."
 */

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export const runtime = "edge";

interface ProgressResponse {
  remaining: number;
  total: number;
  pctComplete: number | null;
}

interface SampleRow {
  id: string;
  sourceName: string | null;
  sourceUrl: string | null;
  sourceDomain: string | null;
  ingestionMethod: string | null;
  changed: boolean;
}

interface BackfillResponse {
  success: boolean;
  apply: boolean;
  candidates: number;
  written: number;
  methodCounts: Record<string, number>;
  sample: SampleRow[];
}

const ENDPOINT = "/api/admin/backfill/source-domain";

export default function BackfillSourceDomainPage() {
  const [progress, setProgress] = useState<ProgressResponse | null>(null);
  const [result, setResult] = useState<BackfillResponse | null>(null);
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
        const data = (await res.json()) as BackfillResponse;
        setResult(data);
        // Refresh remaining count after an apply run.
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
        <h1 className="text-2xl font-bold text-foreground">
          Backfill: source_domain + ingestion_method
        </h1>
        <p className="text-sm text-muted-foreground mt-1">
          Populates the two new columns on <code>events</code> from the existing{" "}
          <code>source_name</code> + <code>source_url</code>. Idempotent — re-running is safe. See{" "}
          <code>drizzle/0090</code> and <code>src/lib/source-classification.ts</code>.
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
            <div className="flex items-center gap-6">
              <div>
                <p className="text-3xl font-bold text-foreground tabular-nums">
                  {progress.remaining.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">rows remaining</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-foreground tabular-nums">
                  {progress.total.toLocaleString()}
                </p>
                <p className="text-xs text-muted-foreground">total events</p>
              </div>
              <div>
                <p className="text-3xl font-bold text-foreground tabular-nums">
                  {progress.pctComplete == null ? "—" : `${progress.pctComplete}%`}
                </p>
                <p className="text-xs text-muted-foreground">complete</p>
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
              onClick={() => run(false, 20)}
            >
              Preview (20 rows, dry-run)
            </Button>
            <Button type="button" disabled={loading || done} onClick={() => run(true, 500)}>
              Apply batch (500 rows)
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
          {loading && <p className="text-sm text-muted-foreground mt-3">Running…</p>}
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
              Last run {result.apply ? "(applied)" : "(dry-run)"}
            </h2>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              <Stat label="Candidates" value={result.candidates} />
              <Stat label="Written" value={result.written} />
              <Stat label="Methods seen" value={Object.keys(result.methodCounts).length} />
              <Stat label="Sample rows" value={result.sample.length} />
            </div>

            {Object.keys(result.methodCounts).length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-2">By ingestion method</h3>
                <ul className="text-sm text-foreground space-y-1">
                  {Object.entries(result.methodCounts)
                    .sort((a, b) => b[1] - a[1])
                    .map(([method, count]) => (
                      <li key={method} className="flex justify-between max-w-md">
                        <span className="font-mono">{method}</span>
                        <span className="tabular-nums">{count}</span>
                      </li>
                    ))}
                </ul>
              </div>
            )}

            {result.sample.length > 0 && (
              <div>
                <h3 className="text-sm font-semibold text-foreground mb-2">
                  Sample (first {result.sample.length})
                </h3>
                <div className="overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead>
                      <tr className="border-b border-border text-left text-muted-foreground">
                        <th className="py-2 pr-3">source_name</th>
                        <th className="py-2 pr-3">source_url</th>
                        <th className="py-2 pr-3">→ source_domain</th>
                        <th className="py-2 pr-3">→ ingestion_method</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.sample.map((row) => (
                        <tr key={row.id} className="border-b border-border">
                          <td className="py-2 pr-3 font-mono text-foreground max-w-[160px] truncate">
                            {row.sourceName ?? <span className="text-muted-foreground">null</span>}
                          </td>
                          <td className="py-2 pr-3 font-mono text-foreground max-w-[280px] truncate">
                            {row.sourceUrl ?? <span className="text-muted-foreground">null</span>}
                          </td>
                          <td className="py-2 pr-3 font-mono text-foreground">
                            {row.sourceDomain ?? (
                              <span className="text-muted-foreground">null</span>
                            )}
                          </td>
                          <td className="py-2 pr-3 font-mono text-foreground">
                            {row.ingestionMethod ?? (
                              <span className="text-muted-foreground">null</span>
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

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div>
      <p className="text-2xl font-bold text-foreground tabular-nums">{value.toLocaleString()}</p>
      <p className="text-xs text-muted-foreground">{label}</p>
    </div>
  );
}
