import { requireAdmin } from "@/lib/require-admin";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventSchemaOrg, events, venues, promoters } from "@/lib/db/schema";
import { count, eq, isNotNull } from "drizzle-orm";
import { eventJoinProjection } from "@/lib/db/event-join-projection";
import { SchemaOrgSyncButton } from "@/components/admin/SchemaOrgSyncButton";
import { logError } from "@/lib/logger";
import { formatQueueAge, loadQueueHealth, type QueueTile } from "@/lib/admin/queue-health";

async function getSchemaOrgSummary(): Promise<{ synced: number; ticketed: number } | null> {
  const db = getCloudflareDb();
  try {
    const [[ticketed], [synced]] = await Promise.all([
      db.select({ n: count() }).from(events).where(isNotNull(events.ticketUrl)),
      db.select({ n: count() }).from(eventSchemaOrg).where(eq(eventSchemaOrg.status, "available")),
    ]);
    return { ticketed: ticketed?.n ?? 0, synced: synced?.n ?? 0 };
  } catch (e) {
    await logError(db, {
      message: "Error fetching Schema.org summary",
      error: e,
      source: "app/admin/page.tsx:getSchemaOrgSummary",
    });
    return null;
  }
}

async function getRecentSubmissions() {
  const db = getCloudflareDb();

  try {
    // Narrow projection — D1 caps result rows at 100 columns and the
    // unfiltered events+venues+promoters join is 104. See
    // src/lib/db/event-join-projection.ts for the audit + maintenance
    // contract. Deferred from PR #327 (1 err/day signal); now picked
    // up because the page-error canary (PR #329) would otherwise
    // dispatch on it every admin visit.
    const results = await db
      .select(eventJoinProjection)
      .from(events)
      .leftJoin(promoters, eq(events.promoterId, promoters.id))
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eq(events.status, "PENDING"))
      .orderBy(events.createdAt)
      .limit(5);

    // Cast lite projection back to schema row types — only fields read
    // downstream are `promoter.companyName` and `venue.name`, both in
    // the projection. Same pattern as #325/#327/#328.
    type FullVenue = typeof venues.$inferSelect;
    type FullPromoter = typeof promoters.$inferSelect;
    type EventRow = (typeof results)[number];
    return results.map((r: EventRow) => ({
      ...r.events,
      promoter: r.promoter as FullPromoter,
      venue: r.venue as FullVenue,
    }));
  } catch (e) {
    await logError(db, {
      message: "Error fetching submissions",
      error: e,
      source: "app/admin/page.tsx:getRecentSubmissions",
    });
    return [];
  }
}

export const dynamic = "force-dynamic";

function fmtCount(n: number | null): string {
  return n == null ? "—" : n.toLocaleString("en-US");
}

function QueueTileCard({ tile }: { tile: QueueTile }) {
  return (
    <Link prefetch={false} href={tile.href}>
      <Card className="h-full hover:shadow-md transition-shadow cursor-pointer">
        <CardContent className="p-5">
          <p className="text-sm text-muted-foreground">{tile.label}</p>
          <p className="text-3xl font-bold text-foreground mt-1 tabular-nums">
            {fmtCount(tile.actionable)}
          </p>
          <p className="text-xs text-muted-foreground mt-2 tabular-nums">
            Oldest {formatQueueAge(tile.oldestAgeHours)} · 7d in {fmtCount(tile.in7d)} / out{" "}
            {fmtCount(tile.out7d)}
          </p>
        </CardContent>
      </Card>
    </Link>
  );
}

export default async function AdminDashboard() {
  await requireAdmin();
  const [queues, recentSubmissions, schemaOrg] = await Promise.all([
    loadQueueHealth(getCloudflareDb()),
    getRecentSubmissions(),
    getSchemaOrgSummary(),
  ]);

  return (
    <div>
      <h1 className="text-2xl font-bold text-foreground mb-2">Admin Dashboard</h1>
      <p className="text-sm text-muted-foreground mb-6">
        What needs doing, by queue. Catalog totals are on{" "}
        <Link prefetch={false} href="/admin/analytics" className="underline">
          Analytics
        </Link>
        .
      </p>
      {/* OPE-1602: a phone tool, so it is linked here on small screens, not in the sidebar. */}
      <Link
        prefetch={false}
        href="/admin/snap"
        className="md:hidden inline-block mb-6 text-sm font-medium text-royal hover:text-navy"
      >
        Snap booth photo
      </Link>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
        {queues.map((tile) => (
          <QueueTileCard key={tile.key} tile={tile} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Recent Submissions */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-foreground">Recent Submissions</h2>
          </CardHeader>
          <CardContent>
            {recentSubmissions.length === 0 ? (
              <p className="text-muted-foreground py-4">No pending submissions</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentSubmissions.map((event) => (
                  <div key={event.id} className="py-4 flex items-center justify-between">
                    <div>
                      <p className="font-medium text-foreground">{event.name}</p>
                      <p className="text-sm text-muted-foreground">
                        by {event.promoter.companyName} at {event.venue?.name || "TBD"}
                      </p>
                    </div>
                    <Link
                      href={`/admin/submissions?id=${event.id}`}
                      className="text-sm text-royal hover:text-navy font-medium"
                    >
                      Review
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* OPE-1603 — compact: the sync controls open on demand. */}
        <Card>
          <CardContent className="p-5">
            <details>
              <summary className="cursor-pointer">
                <span className="text-sm text-muted-foreground">Schema.org sync</span>
                <span className="block text-2xl font-bold text-foreground mt-1 tabular-nums">
                  {schemaOrg
                    ? `${fmtCount(schemaOrg.synced)} of ${fmtCount(schemaOrg.ticketed)}`
                    : "—"}
                </span>
                <span className="text-xs text-muted-foreground">
                  ticket-URL events synced · open for controls
                </span>
              </summary>
              <div className="mt-4">
                <SchemaOrgSyncButton />
              </div>
            </details>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
