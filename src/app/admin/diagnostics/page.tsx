/**
 * §10.3 Diagnostic dashboard.
 *
 * Surfaces pipeline health, not business metrics. Operator visits when
 * deciding "do I trust the analytics dashboard right now?" Includes:
 *
 *   - Pipeline health cards: enrichment success rate by source and
 *     time-to-index reconciliation rate. IndexNow lives on its Analytics tab;
 *     grouped errors live on /admin/logs.
 *
 * Auth: redirected to /signin if not admin (mirrors /admin/analytics).
 */
import Link from "next/link";
import { requireAdmin } from "@/lib/require-admin";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { loadDiagnosticsSnapshot } from "@/lib/diagnostics";
import { formatTimestampForServer } from "@/lib/datetime";

export const dynamic = "force-dynamic";

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

function fmtPct(x: number, digits = 1): string {
  return `${(x * 100).toFixed(digits)}%`;
}

function fmtAge(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

export default async function AdminDiagnosticsPage() {
  await requireAdmin({ allowReadonlyBearer: false });

  const db = getCloudflareDb();
  const snapshot = await loadDiagnosticsSnapshot(db);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-foreground">Diagnostics</h1>
        <p className="text-xs text-muted-foreground">
          Generated {formatTimestampForServer(snapshot.generatedAt)}
        </p>
      </div>

      <p className="text-sm text-muted-foreground mb-4">
        IndexNow health is on the{" "}
        <Link prefetch={false} href="/admin/analytics?tab=indexnow" className="underline">
          IndexNow tab
        </Link>
        .
      </p>

      {/* Pipeline health cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mb-6">
        <Card
          className={
            snapshot.timeToIndex.unresolved > 100 ||
            (snapshot.timeToIndex.oldestUnresolvedAgeSeconds ?? 0) > 7 * 86400
              ? "border-amber-300"
              : ""
          }
        >
          <CardHeader>
            <CardTitle>Time-to-index reconciliation</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-foreground tabular-nums">
              {fmtPct(snapshot.timeToIndex.resolvedRate)}
            </p>
            <p className="text-xs text-muted-foreground mt-2">
              {fmt(snapshot.timeToIndex.resolved)} resolved / {fmt(snapshot.timeToIndex.unresolved)}{" "}
              unresolved
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              Oldest unresolved: {fmtAge(snapshot.timeToIndex.oldestUnresolvedAgeSeconds)}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Enrichment sources (7d)</CardTitle>
          </CardHeader>
          <CardContent>
            {snapshot.enrichmentBySource.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No enrichment activity in the last 7 days.
              </p>
            ) : (
              <ul className="space-y-1.5 text-sm">
                {snapshot.enrichmentBySource.map((s) => (
                  <li key={s.source} className="flex justify-between gap-4">
                    <span className="font-mono text-xs text-foreground">{s.source}</span>
                    <span
                      className={
                        s.successRate < 0.8
                          ? "text-amber-700 font-medium tabular-nums text-xs"
                          : "text-muted-foreground tabular-nums text-xs"
                      }
                    >
                      {fmtPct(s.successRate, 0)} of {fmt(s.total)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <p className="text-sm text-muted-foreground">
        Grouped errors are on{" "}
        <Link prefetch={false} href="/admin/logs" className="underline">
          Error Logs
        </Link>
        .
      </p>
    </div>
  );
}
