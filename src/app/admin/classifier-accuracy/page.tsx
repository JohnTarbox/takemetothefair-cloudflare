"use client";

/**
 * Phase D.1 §3g — weekly classifier accuracy dashboard. Companion to
 * the rolling 30-day badge on /admin/inbound-emails.
 *
 * Three sections:
 *   1. Per-classifier_version accuracy trend (12 weeks) as inline-SVG
 *      line chart. Each version is one line; x = week, y = accuracy %.
 *   2. Top 5 disagreement pairs (original → corrected, with counts).
 *   3. Full disagreement matrix as a CSS-grid heatmap.
 *
 * Inline SVG instead of a charting library — the rest of /admin has no
 * chart dep and one isn't worth pulling in for a single line chart.
 * Keeps the bundle small.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const runtime = "edge";

interface WeeklyBucket {
  weekStart: string;
  weekIndex: number;
  classifierVersion: string;
  total: number;
  disagreements: number;
  accuracyPct: number | null;
}

interface DisagreementPair {
  originalIntent: string | null;
  correctedIntent: string;
  n: number;
}

interface WeeklyResponse {
  windowWeeks: number;
  windowStart: string;
  buckets: WeeklyBucket[];
  versions: string[];
  topDisagreements: DisagreementPair[];
  disagreementMatrix: DisagreementPair[];
}

const LINE_COLORS = ["#2563eb", "#dc2626", "#16a34a", "#ea580c", "#9333ea", "#0891b2"];

export default function ClassifierAccuracyPage() {
  const [data, setData] = useState<WeeklyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/inbound-emails/classifier-stats/weekly?weeks=12");
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setData((await res.json()) as WeeklyResponse);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) return <div className="p-8">Loading…</div>;
  if (error) return <div className="p-8 text-red-700">Couldn&apos;t load: {error}</div>;
  if (!data) return null;

  return (
    <main className="mx-auto max-w-5xl space-y-6 p-8">
      <header>
        <h1 className="text-2xl font-semibold">Classifier accuracy — weekly trend</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Last {data.windowWeeks} weeks, per classifier_version. Disagreements counted from{" "}
          <code>admin_reroute</code> + <code>sender_feedback</code> rows only (confirmations
          excluded).
        </p>
      </header>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Accuracy over time</h2>
        </CardHeader>
        <CardContent>
          <AccuracyChart buckets={data.buckets} versions={data.versions} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Top disagreement pairs (this window)</h2>
        </CardHeader>
        <CardContent>
          {data.topDisagreements.length === 0 ? (
            <p className="text-sm text-muted-foreground">No disagreements in this window.</p>
          ) : (
            <ol className="space-y-2">
              {data.topDisagreements.map((d, i) => (
                <li key={i} className="flex items-center justify-between border-b pb-2 text-sm">
                  <span>
                    <code className="rounded bg-red-50 px-1.5 py-0.5 text-red-800">
                      {d.originalIntent ?? "(null)"}
                    </code>{" "}
                    →{" "}
                    <code className="rounded bg-green-50 px-1.5 py-0.5 text-green-800">
                      {d.correctedIntent}
                    </code>
                  </span>
                  <span className="font-mono text-foreground">{d.n}</span>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-medium">Disagreement heatmap</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            Rows = classifier&apos;s call; columns = admin/sender correction. Darker = more
            disagreements.
          </p>
        </CardHeader>
        <CardContent>
          <DisagreementHeatmap matrix={data.disagreementMatrix} />
        </CardContent>
      </Card>
    </main>
  );
}

/**
 * SVG line chart of accuracy% over weekly buckets. One line per
 * classifier_version. Buckets with zero classifications are rendered
 * as gaps in the line (not zero) — accuracyPct=null. Y axis is 0-100;
 * X axis is week-start dates, every other label.
 */
function AccuracyChart({ buckets, versions }: { buckets: WeeklyBucket[]; versions: string[] }) {
  // Group buckets by version, sorted by weekIndex ascending.
  const byVersion = useMemo(() => {
    const m = new Map<string, WeeklyBucket[]>();
    for (const v of versions) m.set(v, []);
    for (const b of buckets) {
      m.get(b.classifierVersion)?.push(b);
    }
    for (const arr of m.values()) arr.sort((a, b) => a.weekIndex - b.weekIndex);
    return m;
  }, [buckets, versions]);

  const weekCount = useMemo(() => {
    let max = 0;
    for (const arr of byVersion.values()) max = Math.max(max, arr.length);
    return max;
  }, [byVersion]);

  if (weekCount === 0) {
    return (
      <p className="text-sm text-muted-foreground">No classified emails in this window yet.</p>
    );
  }

  // SVG coordinate system: 720x240 with 40px left + 30px bottom padding.
  const W = 720;
  const H = 240;
  const PAD_L = 40;
  const PAD_R = 20;
  const PAD_T = 10;
  const PAD_B = 30;
  const chartW = W - PAD_L - PAD_R;
  const chartH = H - PAD_T - PAD_B;
  const xStep = weekCount > 1 ? chartW / (weekCount - 1) : 0;

  // X-axis labels: every other bucket's weekStart (DDM format) to avoid
  // crowding.
  const labelBuckets = byVersion.values().next().value ?? [];
  const labels = labelBuckets.map((b: WeeklyBucket, i: number) => ({
    x: PAD_L + i * xStep,
    label: i % 2 === 0 ? b.weekStart.slice(5) : "",
  }));

  // Y gridlines at 0, 25, 50, 75, 100.
  const yGrid = [0, 25, 50, 75, 100];
  const yFor = (pct: number) => PAD_T + chartH - (pct / 100) * chartH;

  return (
    <div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label="Accuracy trend">
        {/* Y gridlines + labels */}
        {yGrid.map((y) => (
          <g key={y}>
            <line
              x1={PAD_L}
              x2={W - PAD_R}
              y1={yFor(y)}
              y2={yFor(y)}
              stroke="#e5e7eb"
              strokeDasharray="2 2"
            />
            <text x={PAD_L - 6} y={yFor(y) + 3} fontSize="10" fill="#6b7280" textAnchor="end">
              {y}%
            </text>
          </g>
        ))}
        {/* X-axis labels */}
        {labels.map((l: { x: number; label: string }, i: number) =>
          l.label ? (
            <text
              key={i}
              x={l.x}
              y={H - PAD_B + 14}
              fontSize="9"
              fill="#6b7280"
              textAnchor="middle"
            >
              {l.label}
            </text>
          ) : null
        )}
        {/* Lines per version */}
        {[...byVersion.entries()].map(([version, arr], vi) => {
          const color = LINE_COLORS[vi % LINE_COLORS.length];
          // Build d-path. accuracyPct=null breaks the line.
          let d = "";
          let lastDrawn = false;
          arr.forEach((b: WeeklyBucket, i: number) => {
            if (b.accuracyPct === null) {
              lastDrawn = false;
              return;
            }
            const x = PAD_L + i * xStep;
            const y = yFor(b.accuracyPct);
            d += `${lastDrawn ? "L" : "M"}${x} ${y} `;
            lastDrawn = true;
          });
          return (
            <g key={version}>
              <path d={d} stroke={color} strokeWidth="2" fill="none" />
              {/* Per-point dots */}
              {arr.map((b: WeeklyBucket, i: number) =>
                b.accuracyPct === null ? null : (
                  <circle
                    key={i}
                    cx={PAD_L + i * xStep}
                    cy={yFor(b.accuracyPct)}
                    r="3"
                    fill={color}
                  >
                    <title>
                      {version}, {b.weekStart}: {b.accuracyPct}% ({b.total - b.disagreements}/
                      {b.total})
                    </title>
                  </circle>
                )
              )}
            </g>
          );
        })}
      </svg>
      {/* Legend */}
      <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {[...byVersion.keys()].map((version, vi) => (
          <li key={version} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-3"
              style={{ backgroundColor: LINE_COLORS[vi % LINE_COLORS.length] }}
            />
            <code className="text-foreground">{version}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * CSS-grid heatmap. Rows = original intent, columns = corrected intent.
 * Cells colored by count (white→red); count text shown when non-zero.
 */
function DisagreementHeatmap({ matrix }: { matrix: DisagreementPair[] }) {
  // Build the row/column index from observed values.
  const originals = useMemo(() => {
    const s = new Set<string>();
    matrix.forEach((m) => s.add(m.originalIntent ?? "(null)"));
    return [...s].sort();
  }, [matrix]);
  const correcteds = useMemo(() => {
    const s = new Set<string>();
    matrix.forEach((m) => s.add(m.correctedIntent));
    return [...s].sort();
  }, [matrix]);
  const lookup = useMemo(() => {
    const m = new Map<string, number>();
    matrix.forEach((p) => m.set(`${p.originalIntent ?? "(null)"} ${p.correctedIntent}`, p.n));
    return m;
  }, [matrix]);
  const maxN = useMemo(() => Math.max(1, ...matrix.map((m) => m.n)), [matrix]);

  if (originals.length === 0 || correcteds.length === 0) {
    return <p className="text-sm text-muted-foreground">No disagreements in this window.</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-xs">
        <thead>
          <tr>
            <th className="border-b border-r p-2"></th>
            {correcteds.map((c) => (
              <th key={c} className="border-b border-r p-2 text-left font-medium text-foreground">
                <code>{c}</code>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {originals.map((o) => (
            <tr key={o}>
              <th className="border-b border-r p-2 text-left font-medium text-foreground">
                <code>{o}</code>
              </th>
              {correcteds.map((c) => {
                const n = lookup.get(`${o} ${c}`) ?? 0;
                const intensity = n / maxN;
                const bg =
                  n === 0 ? "transparent" : `rgba(220, 38, 38, ${0.15 + intensity * 0.55})`;
                return (
                  <td
                    key={c}
                    className="border-b border-r p-2 text-center font-mono"
                    style={{ backgroundColor: bg }}
                    title={`${o} → ${c}: ${n}`}
                  >
                    {n || ""}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
