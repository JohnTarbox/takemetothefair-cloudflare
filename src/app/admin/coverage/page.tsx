import Link from "next/link";
import { Calendar, MapPin, Store, FileText } from "lucide-react";
import { and, desc, eq, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  blogPosts,
  contentLinks,
  events,
  vendors,
  venues,
} from "@/lib/db/schema";
import { isPublicEventStatus } from "@/lib/event-status";
import { Card, CardContent, CardHeader } from "@/components/ui/card";

export const runtime = "edge";
export const revalidate = 300;

interface CoverageRow {
  id: string;
  slug: string;
  name: string;
  state: string | null;
  blogPostCount: number;
}

/**
 * Returns rows for the given entity type, sorted by blog-post count ASC so
 * zero-coverage entities float to the top. One aggregated LEFT JOIN.
 */
async function getCoverage(type: "EVENT" | "VENDOR" | "VENUE"): Promise<CoverageRow[]> {
  const db = getCloudflareDb();

  // Aggregated link counts per target id.
  const counts = await db
    .select({
      targetId: contentLinks.targetId,
      n: sql<number>`count(distinct ${contentLinks.sourceId})`,
    })
    .from(contentLinks)
    .innerJoin(blogPosts, eq(contentLinks.sourceId, blogPosts.id))
    .where(
      and(
        eq(contentLinks.sourceType, "BLOG_POST"),
        eq(contentLinks.targetType, type),
        eq(blogPosts.status, "PUBLISHED"),
      ),
    )
    .groupBy(contentLinks.targetId);
  const byId = new Map(
    counts
      .filter((r): r is { targetId: string; n: number } => !!r.targetId)
      .map((r) => [r.targetId, Number(r.n)]),
  );

  // Events don't carry state directly — derive it via their venue.
  let rows: Array<{ id: string; slug: string; name: string; state: string | null }>;
  if (type === "EVENT") {
    rows = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        state: venues.state,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(isPublicEventStatus())
      .orderBy(desc(events.id));
  } else if (type === "VENUE") {
    rows = await db
      .select({ id: venues.id, slug: venues.slug, name: venues.name, state: venues.state })
      .from(venues)
      .where(eq(venues.status, "ACTIVE"))
      .orderBy(desc(venues.id));
  } else {
    rows = await db
      .select({
        id: vendors.id,
        slug: vendors.slug,
        name: vendors.businessName,
        state: vendors.state,
      })
      .from(vendors)
      .orderBy(desc(vendors.id));
  }

  return rows
    .map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      state: r.state,
      blogPostCount: byId.get(r.id) ?? 0,
    }))
    .sort((a, b) => a.blogPostCount - b.blogPostCount || a.name.localeCompare(b.name));
}

function CoverageTable({
  rows,
  detailPath,
  emptyLabel,
}: {
  rows: CoverageRow[];
  detailPath: string;
  emptyLabel: string;
}) {
  if (rows.length === 0) {
    return <p className="text-sm text-stone-600">{emptyLabel}</p>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full">
        <thead>
          <tr className="border-b border-stone-100 text-left text-sm text-stone-600">
            <th className="py-2 px-3 font-medium">Name</th>
            <th className="py-2 px-3 font-medium">State</th>
            <th className="py-2 px-3 font-medium w-24">Blog posts</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} className="border-b border-stone-100 hover:bg-stone-50">
              <td className="py-2 px-3">
                <Link
                  href={`${detailPath}/${row.slug}`}
                  className="text-gray-900 hover:text-navy font-medium"
                >
                  {row.name}
                </Link>
              </td>
              <td className="py-2 px-3 text-gray-600 text-sm">{row.state ?? "-"}</td>
              <td className="py-2 px-3">
                {row.blogPostCount > 0 ? (
                  <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-amber-light text-amber-dark">
                    {row.blogPostCount}
                  </span>
                ) : (
                  <span className="text-xs text-red-600 font-medium">0</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function AdminCoveragePage() {
  const [eventRows, vendorRows, venueRows] = await Promise.all([
    getCoverage("EVENT"),
    getCoverage("VENDOR"),
    getCoverage("VENUE"),
  ]);

  const zeroEvents = eventRows.filter((r) => r.blogPostCount === 0).length;
  const zeroVendors = vendorRows.filter((r) => r.blogPostCount === 0).length;
  const zeroVenues = venueRows.filter((r) => r.blogPostCount === 0).length;

  return (
    <div>
      <div className="mb-8">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <FileText className="w-6 h-6 text-amber-dark" />
          Blog Coverage
        </h1>
        <p className="mt-1 text-gray-600 max-w-3xl">
          Entities sorted by blog-post coverage ascending — zero-coverage items float to the top.
          Use this to prioritize what to write about next.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="rounded-lg border border-stone-100 bg-stone-50 p-4">
          <p className="text-xs uppercase tracking-wide text-stone-600">Events with 0 posts</p>
          <p className="text-2xl font-bold text-stone-900 mt-1">
            {zeroEvents} <span className="text-sm font-normal text-stone-600">/ {eventRows.length}</span>
          </p>
        </div>
        <div className="rounded-lg border border-stone-100 bg-stone-50 p-4">
          <p className="text-xs uppercase tracking-wide text-stone-600">Vendors with 0 posts</p>
          <p className="text-2xl font-bold text-stone-900 mt-1">
            {zeroVendors} <span className="text-sm font-normal text-stone-600">/ {vendorRows.length}</span>
          </p>
        </div>
        <div className="rounded-lg border border-stone-100 bg-stone-50 p-4">
          <p className="text-xs uppercase tracking-wide text-stone-600">Venues with 0 posts</p>
          <p className="text-2xl font-bold text-stone-900 mt-1">
            {zeroVenues} <span className="text-sm font-normal text-stone-600">/ {venueRows.length}</span>
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              Events
            </h2>
          </CardHeader>
          <CardContent>
            <CoverageTable
              rows={eventRows.slice(0, 200)}
              detailPath="/events"
              emptyLabel="No events to report."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Store className="w-5 h-5" />
              Vendors
            </h2>
          </CardHeader>
          <CardContent>
            <CoverageTable
              rows={vendorRows.slice(0, 200)}
              detailPath="/vendors"
              emptyLabel="No vendors to report."
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <MapPin className="w-5 h-5" />
              Venues
            </h2>
          </CardHeader>
          <CardContent>
            <CoverageTable
              rows={venueRows.slice(0, 200)}
              detailPath="/venues"
              emptyLabel="No venues to report."
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
