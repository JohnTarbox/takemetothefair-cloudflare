/**
 * UR1 C4 (2026-06-04) — single problem-report detail + resolve action.
 *
 * Shows the full body, the linked inbound_email row (if email source),
 * error_logs entries in the correlation window for HIGH-severity rows,
 * and a resolve form.
 */

import Link from "next/link";
import { and, eq, gte, lt } from "drizzle-orm";
import { redirect, notFound } from "next/navigation";
import { getCloudflareDb } from "@/lib/cloudflare";
import { problemReports, errorLogs, inboundEmails, users } from "@/lib/db/schema";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { auth } from "@/lib/auth";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function AdminProblemReportDetailPage({ params }: Props) {
  const session = await auth();
  if (session?.user?.role !== "ADMIN") redirect("/");

  const { id } = await params;
  const db = getCloudflareDb();

  const [row] = await db.select().from(problemReports).where(eq(problemReports.id, id)).limit(1);
  if (!row) notFound();

  // Linked inbound email (if email-sourced).
  let inboundEmail: typeof inboundEmails.$inferSelect | null = null;
  if (row.inboundEmailId) {
    const ie = await db
      .select()
      .from(inboundEmails)
      .where(eq(inboundEmails.id, row.inboundEmailId))
      .limit(1);
    inboundEmail = ie[0] ?? null;
  }

  // Correlated error_logs entries — re-pull the window so admin sees
  // the same data the burst-watch did (or, if correlation was deferred
  // for the web path, sees what NEW errors landed since report time).
  const since = new Date(row.createdAt.getTime() - 30 * 60_000);
  const until = new Date(row.createdAt.getTime() + 5 * 60_000);
  const relatedErrors = await db
    .select()
    .from(errorLogs)
    .where(
      and(
        gte(errorLogs.timestamp, since),
        lt(errorLogs.timestamp, until),
        eq(errorLogs.level, "error")
      )
    )
    .limit(50);

  // Resolver display name.
  let resolverName: string | null = null;
  if (row.resolvedByUserId) {
    const rb = await db
      .select({ name: users.name, email: users.email })
      .from(users)
      .where(eq(users.id, row.resolvedByUserId))
      .limit(1);
    resolverName = rb[0]?.name ?? rb[0]?.email ?? row.resolvedByUserId;
  }

  return (
    <div className="mx-auto max-w-4xl px-4 sm:px-6 lg:px-8 py-8">
      <Link href="/admin/problem-reports" className="text-sm text-royal hover:underline">
        ← Back to all reports
      </Link>

      <div className="mt-2 flex items-center gap-3">
        <h1 className="text-2xl font-bold text-navy">Problem report</h1>
        {row.severity === "HIGH" ? (
          <Badge variant="danger">HIGH ({row.correlatedErrorCount} co-occurring errors)</Badge>
        ) : (
          <Badge variant="default">LOW</Badge>
        )}
        {row.resolvedAt ? (
          <Badge variant="success">Resolved</Badge>
        ) : (
          <Badge variant="warning">Open</Badge>
        )}
      </div>

      <p className="mt-2 text-sm text-muted-foreground">
        ID: <code className="text-xs">{row.id}</code>
      </p>

      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-sm font-semibold">Report</h2>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <Field label="When">{row.createdAt.toISOString()}</Field>
          <Field label="Source">{row.source}</Field>
          <Field label="Reporter">
            {row.reporterEmail ?? <span className="text-muted-foreground italic">anonymous</span>}
          </Field>
          <Field label="Page">{row.path ?? "—"}</Field>
          <Field label="User-Agent">
            <span className="text-xs text-muted-foreground">{row.userAgent ?? "—"}</span>
          </Field>
          <div>
            <div className="text-xs font-semibold text-foreground mb-1">Body</div>
            <pre className="text-sm bg-muted p-3 rounded-md whitespace-pre-wrap font-sans">
              {row.body}
            </pre>
          </div>
        </CardContent>
      </Card>

      {inboundEmail && (
        <Card className="mt-6">
          <CardHeader>
            <h2 className="text-sm font-semibold">Linked inbound email</h2>
          </CardHeader>
          <CardContent className="text-sm space-y-2">
            <Field label="Subject">{inboundEmail.subject ?? "(no subject)"}</Field>
            <Field label="From">{inboundEmail.fromAddress}</Field>
            <Field label="Received">{inboundEmail.receivedAt.toISOString()}</Field>
            <Link
              href={`/admin/inbound-emails?id=${inboundEmail.id}`}
              className="text-royal text-xs hover:underline inline-block"
            >
              Open in inbound-emails queue →
            </Link>
          </CardContent>
        </Card>
      )}

      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-sm font-semibold">
            error_logs in the (−30m / +5m) window ({relatedErrors.length} rows)
          </h2>
        </CardHeader>
        <CardContent className="p-0">
          {relatedErrors.length === 0 ? (
            <p className="text-sm text-muted-foreground px-4 py-3">
              No errors in the window. The report likely describes a content / data issue rather
              than a runtime outage.
            </p>
          ) : (
            <table className="w-full text-xs">
              <thead className="bg-muted">
                <tr>
                  <th className="text-left px-3 py-2 font-medium text-foreground">When</th>
                  <th className="text-left px-3 py-2 font-medium text-foreground">Source</th>
                  <th className="text-left px-3 py-2 font-medium text-foreground">Message</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {relatedErrors.map((e) => (
                  <tr key={e.id}>
                    <td className="px-3 py-2 whitespace-nowrap text-muted-foreground">
                      {e.timestamp.toISOString().slice(11, 19)}
                    </td>
                    <td className="px-3 py-2 text-foreground">
                      <code className="text-xs">{e.source ?? "—"}</code>
                    </td>
                    <td className="px-3 py-2 text-foreground max-w-md truncate">{e.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      <Card className="mt-6">
        <CardHeader>
          <h2 className="text-sm font-semibold">
            {row.resolvedAt ? "Resolution" : "Resolve this report"}
          </h2>
        </CardHeader>
        <CardContent className="text-sm">
          {row.resolvedAt ? (
            <div className="space-y-2">
              <Field label="Resolved at">{row.resolvedAt.toISOString()}</Field>
              <Field label="Resolved by">{resolverName ?? "—"}</Field>
              {row.notes && (
                <div>
                  <div className="text-xs font-semibold text-foreground mb-1">Notes</div>
                  <pre className="text-sm bg-muted p-3 rounded-md whitespace-pre-wrap font-sans">
                    {row.notes}
                  </pre>
                </div>
              )}
            </div>
          ) : (
            <form
              action={`/api/admin/problem-reports/${row.id}/resolve`}
              method="POST"
              className="space-y-3"
            >
              <div>
                <label htmlFor="notes" className="block text-xs font-semibold text-foreground mb-1">
                  Notes (optional — what you did / why this is closed)
                </label>
                <textarea
                  id="notes"
                  name="notes"
                  rows={4}
                  maxLength={2000}
                  className="w-full px-3 py-2 border border-border rounded-md focus:border-royal focus:outline-none focus:ring-1 focus:ring-royal text-sm"
                />
              </div>
              <button
                type="submit"
                className="px-4 py-2 rounded-md bg-secondary text-secondary-foreground font-semibold text-sm hover:bg-royal/90"
              >
                Mark resolved
              </button>
            </form>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <span className="text-xs font-semibold text-foreground min-w-[100px]">{label}:</span>
      <span className="text-sm text-foreground">{children}</span>
    </div>
  );
}
