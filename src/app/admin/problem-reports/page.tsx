/**
 * UR1 C4 (2026-06-04) — admin queue for user problem reports.
 *
 * List view. Default filter: open (resolved_at IS NULL). Sortable by
 * created_at (desc default) or severity. HIGH-severity rows visually
 * distinguished via a red badge.
 *
 * Detail view at /admin/problem-reports/[id] handles single-row
 * triage + resolve action.
 */

import Link from "next/link";
import { and, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { problemReports } from "@/lib/db/schema";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { auth } from "@/lib/auth";
import { redirect } from "next/navigation";

export const runtime = "edge";
// No revalidate — operator workflow is real-time.
export const dynamic = "force-dynamic";

interface SearchParams {
  resolved?: "true" | "false" | "all";
  severity?: "HIGH" | "LOW" | "all";
}

export default async function AdminProblemReportsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") redirect("/");

  const resolved = await searchParams;
  const resolvedFilter = resolved.resolved ?? "false";
  const severityFilter = resolved.severity ?? "all";

  const db = getCloudflareDb();

  const conditions = [];
  if (resolvedFilter === "false") conditions.push(isNull(problemReports.resolvedAt));
  if (resolvedFilter === "true") conditions.push(isNotNull(problemReports.resolvedAt));
  if (severityFilter !== "all") {
    conditions.push(eq(problemReports.severity, severityFilter));
  }

  const rows = await db
    .select()
    .from(problemReports)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(problemReports.createdAt))
    .limit(200);

  // Quick counts for the filter chips.
  const [openCount, resolvedCount, highOpenCount] = await Promise.all([
    db
      .select({ c: sql<number>`count(*)` })
      .from(problemReports)
      .where(isNull(problemReports.resolvedAt))
      .then((r) => r[0]?.c ?? 0),
    db
      .select({ c: sql<number>`count(*)` })
      .from(problemReports)
      .where(isNotNull(problemReports.resolvedAt))
      .then((r) => r[0]?.c ?? 0),
    db
      .select({ c: sql<number>`count(*)` })
      .from(problemReports)
      .where(and(isNull(problemReports.resolvedAt), eq(problemReports.severity, "HIGH")))
      .then((r) => r[0]?.c ?? 0),
  ]);

  return (
    <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:px-8 py-8">
      <h1 className="text-2xl font-bold text-navy mb-2">Problem reports</h1>
      <p className="text-sm text-gray-600 mb-6">
        User-submitted problem reports from the web form (
        <code className="text-xs">/report-problem</code>) and email (
        <code className="text-xs">report@</code> / <code className="text-xs">feedback@</code>).
        HIGH-severity reports co-occur with an error_logs burst in the −30m/+5m window around report
        time.
      </p>

      <div className="flex flex-wrap gap-2 mb-6">
        <FilterLink
          current={resolvedFilter}
          value="false"
          label={`Open (${openCount})`}
          param="resolved"
        />
        <FilterLink
          current={resolvedFilter}
          value="true"
          label={`Resolved (${resolvedCount})`}
          param="resolved"
        />
        <FilterLink current={resolvedFilter} value="all" label="All" param="resolved" />
        <span className="text-gray-400 mx-2">·</span>
        <FilterLink current={severityFilter} value="all" label="Any severity" param="severity" />
        <FilterLink
          current={severityFilter}
          value="HIGH"
          label={`HIGH (${highOpenCount} open)`}
          param="severity"
        />
        <FilterLink current={severityFilter} value="LOW" label="LOW" param="severity" />
      </div>

      {rows.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-gray-500">
            No reports match the current filter.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <h2 className="text-sm font-semibold text-gray-800">
              {rows.length} report{rows.length === 1 ? "" : "s"}
            </h2>
          </CardHeader>
          <CardContent className="p-0">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-t border-gray-200">
                <tr>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">When</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Severity</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Source</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Reporter</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Page</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Body excerpt</th>
                  <th className="text-left px-4 py-2 font-medium text-gray-700">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.id} className="hover:bg-gray-50">
                    <td className="px-4 py-2 whitespace-nowrap text-gray-700">
                      <Link
                        href={`/admin/problem-reports/${r.id}`}
                        className="text-royal hover:underline"
                      >
                        {r.createdAt.toISOString().slice(0, 16).replace("T", " ")}
                      </Link>
                    </td>
                    <td className="px-4 py-2">
                      {r.severity === "HIGH" ? (
                        <Badge variant="danger">HIGH ({r.correlatedErrorCount})</Badge>
                      ) : (
                        <Badge variant="default">LOW</Badge>
                      )}
                    </td>
                    <td className="px-4 py-2 text-gray-700">{r.source}</td>
                    <td className="px-4 py-2 text-gray-700">
                      {r.reporterEmail ?? <span className="text-gray-400 italic">anonymous</span>}
                    </td>
                    <td className="px-4 py-2 text-gray-700">
                      {r.path ? <code className="text-xs">{r.path}</code> : "—"}
                    </td>
                    <td className="px-4 py-2 text-gray-700 max-w-md">
                      <span className="line-clamp-2">{r.body.slice(0, 200)}</span>
                    </td>
                    <td className="px-4 py-2">
                      {r.resolvedAt ? (
                        <Badge variant="success">Resolved</Badge>
                      ) : (
                        <Badge variant="warning">Open</Badge>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function FilterLink({
  current,
  value,
  label,
  param,
}: {
  current: string;
  value: string;
  label: string;
  param: string;
}) {
  const active = current === value;
  const params = new URLSearchParams();
  params.set(param, value);
  return (
    <Link
      href={`/admin/problem-reports?${params.toString()}`}
      className={`text-xs px-3 py-1 rounded-full transition-colors ${
        active ? "bg-royal text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
      }`}
    >
      {label}
    </Link>
  );
}
