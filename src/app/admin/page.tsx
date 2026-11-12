import { requireAdmin } from "@/lib/require-admin";
import Link from "next/link";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { getCloudflareDb } from "@/lib/cloudflare";
import { eventSchemaOrg, events } from "@/lib/db/schema";
import { count, eq, isNotNull } from "drizzle-orm";
import { SchemaOrgSyncButton } from "@/components/admin/SchemaOrgSyncButton";
import { logError } from "@/lib/logger";
import { formatQueueAge, loadQueueHealth, type QueueTile } from "@/lib/admin/queue-health";
import { formatFeedAge, loadFeedLaneTile, type FeedLaneTile } from "@/lib/admin/feed-lane-tile";
import { loadRecentSubmissions, startsSoon } from "@/lib/admin/recent-submissions";
import { daysSince } from "@/lib/pending-buckets";
import { formatDateRange } from "@/lib/utils";

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

async function getRecentSubmissions(now: Date) {
  const db = getCloudflareDb();
  try {
    return await loadRecentSubmissions(db, now);
  } catch (e) {
    await logError(db, {
      message: "Error fetching submissions",
      error: e,
      source: "app/admin/page.tsx:getRecentSubmissions",
    });
    return { rows: [], endedCount: 0 };
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

/** OPE-1632 — "Organizer feeds": funnel bar, backlog age (red past target), coverage, new to us. */
function FeedLaneCard({ tile }: { tile: FeedLaneTile | null }) {
  const pct = (n: number) => (tile && tile.read > 0 ? `${(n / tile.read) * 100}%` : "0%");
  return (
    <Card className="h-full">
      <CardContent className="p-5">
        <p className="text-sm text-muted-foreground">Organizer feeds</p>
        <p className="text-3xl font-bold text-foreground mt-1 tabular-nums">
          {tile ? fmtCount(tile.awaitingReview) : "—"}
          <span className="text-sm font-normal text-muted-foreground"> awaiting review</span>
        </p>
        {tile ? (
          <>
            <p
              className={`text-xs mt-1 tabular-nums ${tile.pastTarget ? "text-red-600 font-semibold" : "text-muted-foreground"}`}
              data-testid="feed-backlog-age"
            >
              Oldest {formatFeedAge(tile.oldestAgeDays)}
              {tile.pastTarget ? ` · past the ${tile.targetDays}d target` : ""}
            </p>
            <div
              className="flex h-2 w-full overflow-hidden rounded bg-muted mt-3"
              role="img"
              aria-label={`Last ${tile.windowDays} days: ${tile.read} items read, ${tile.matched} matched, ${tile.fresh} new, ${tile.dropped} dropped`}
            >
              <div className="bg-green-600" style={{ width: pct(tile.matched) }} />
              <div className="bg-amber-500" style={{ width: pct(tile.fresh) }} />
              <div className="bg-gray-400" style={{ width: pct(tile.dropped) }} />
            </div>
            <p className="text-xs text-muted-foreground mt-2 tabular-nums">
              {tile.windowDays}d: {fmtCount(tile.read)} read · {fmtCount(tile.matched)} matched ·{" "}
              {fmtCount(tile.fresh)} new · {fmtCount(tile.dropped)} dropped
            </p>
            <p className="text-xs text-muted-foreground mt-1 tabular-nums">
              {tile.feedsHealthy} of {tile.feedsEnabled} feeds healthy · coverage{" "}
              {tile.coverageHealthyShare == null
                ? "—"
                : `${Math.round(tile.coverageHealthyShare * 100)}%`}{" "}
              · {fmtCount(tile.newToUs7d)} new to us this week
            </p>
          </>
        ) : (
          <p className="text-xs text-muted-foreground mt-2">Read failed</p>
        )}
      </CardContent>
    </Card>
  );
}

export default async function AdminDashboard() {
  await requireAdmin();
  const now = new Date();
  const [queues, recentSubmissions, schemaOrg, feedLane] = await Promise.all([
    loadQueueHealth(getCloudflareDb()),
    getRecentSubmissions(now),
    getSchemaOrgSummary(),
    loadFeedLaneTile(getCloudflareDb(), now),
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
        <FeedLaneCard tile={feedLane} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 mb-6">
        {/* Recent Submissions */}
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-foreground">Recent Submissions</h2>
          </CardHeader>
          <CardContent>
            {recentSubmissions.rows.length === 0 ? (
              <p className="text-muted-foreground py-4">No upcoming pending submissions</p>
            ) : (
              <div className="divide-y divide-gray-100">
                {recentSubmissions.rows.map((event) => {
                  const dated = event.startDate || event.endDate;
                  const soon = startsSoon(event, now);
                  const ago = event.createdAt ? daysSince(event.createdAt, now) : null;
                  return (
                    <div
                      key={event.id}
                      className={`py-4 flex items-center justify-between ${soon ? "bg-amber-50 -mx-2 px-2 rounded" : ""}`}
                    >
                      <div>
                        <p className="font-medium text-foreground">{event.name}</p>
                        <p className="text-sm text-foreground">
                          {dated ? formatDateRange(event.startDate, event.endDate) : "No date"}
                          {dated && !event.datesConfirmed && (
                            <span className="text-muted-foreground"> · dates TBC</span>
                          )}
                          {soon && <span className="text-amber-700 font-medium"> · soon</span>}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          by {event.promoterName ?? "unknown promoter"} at{" "}
                          {event.venueName || "TBD"}
                          {ago !== null && ` · submitted ${ago === 0 ? "today" : `${ago}d ago`}`}
                        </p>
                      </div>
                      <Link
                        href={`/admin/submissions?id=${event.id}`}
                        className="text-sm text-royal hover:text-navy font-medium"
                      >
                        Review
                      </Link>
                    </div>
                  );
                })}
              </div>
            )}
            {recentSubmissions.endedCount > 0 && (
              <Link
                href="/admin/submissions?bucket=ended"
                className="block pt-3 text-sm text-royal hover:text-navy font-medium"
              >
                +{recentSubmissions.endedCount.toLocaleString("en-US")} ended submissions →
              </Link>
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
