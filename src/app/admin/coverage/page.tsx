import Link from "next/link";
import { Calendar, MapPin, Store, FileText } from "lucide-react";
import { and, desc, eq, gte, isNull, or, sql } from "drizzle-orm";
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
export const dynamic = "force-dynamic";

type EventScope = "all" | "upcoming";
type CoverageFilter = "all" | "uncovered" | "covered";

function buildCoverageHref(scope: EventScope, filter: CoverageFilter): string {
  const params = new URLSearchParams();
  if (scope !== "all") params.set("scope", scope);
  if (filter !== "all") params.set("filter", filter);
  const qs = params.toString();
  return qs ? `/admin/coverage?${qs}` : "/admin/coverage";
}

function applyCoverageView(rows: CoverageRow[], filter: CoverageFilter): CoverageRow[] {
  if (filter === "uncovered") {
    return rows
      .filter((r) => r.blogPostCount === 0)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  if (filter === "covered") {
    return rows
      .filter((r) => r.blogPostCount > 0)
      .sort((a, b) => b.blogPostCount - a.blogPostCount || a.name.localeCompare(b.name));
  }
  return rows;
}

interface CoverageRow {
  id: string;
  slug: string;
  name: string;
  state: string | null;
  blogPostCount: number;
}

async function getCoverage(
  type: "EVENT" | "VENDOR" | "VENUE",
  eventScope: EventScope = "all",
): Promise<CoverageRow[]> {
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

  let rows: Array<{ id: string; slug: string; name: string; state: string | null }>;
  if (type === "EVENT") {
    // Upcoming = event hasn't ended yet. Null end_date kept in the set
    // (TBD-dated events are still worth prioritizing blog coverage for).
    const eventWhere =
      eventScope === "upcoming"
        ? and(
            isPublicEventStatus(),
            or(gte(events.endDate, new Date()), isNull(events.endDate)),
          )
        : isPublicEventStatus();
    rows = await db
      .select({
        id: events.id,
        slug: events.slug,
        name: events.name,
        state: venues.state,
      })
      .from(events)
      .leftJoin(venues, eq(events.venueId, venues.id))
      .where(eventWhere)
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

const TOGGLE_BASE = "px-3 py-1.5 text-sm font-medium rounded-md transition-colors border";
const TOGGLE_ACTIVE = "bg-navy text-white border-navy";
const TOGGLE_INACTIVE = "bg-white text-gray-700 border-stone-200 hover:bg-stone-50";

function ScopeToggle({ scope, filter }: { scope: EventScope; filter: CoverageFilter }) {
  return (
    <div className="inline-flex items-center gap-2" role="group" aria-label="Event scope">
      <span className="text-xs uppercase tracking-wide text-stone-600 mr-1">Events:</span>
      <Link
        href={buildCoverageHref("all", filter)}
        className={`${TOGGLE_BASE} ${scope === "all" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}`}
        aria-pressed={scope === "all"}
      >
        All
      </Link>
      <Link
        href={buildCoverageHref("upcoming", filter)}
        className={`${TOGGLE_BASE} ${scope === "upcoming" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}`}
        aria-pressed={scope === "upcoming"}
      >
        Upcoming only
      </Link>
    </div>
  );
}

function CoverageFilterToggle({
  scope,
  filter,
}: {
  scope: EventScope;
  filter: CoverageFilter;
}) {
  return (
    <div className="inline-flex items-center gap-2" role="group" aria-label="Coverage filter">
      <span className="text-xs uppercase tracking-wide text-stone-600 mr-1">Show:</span>
      <Link
        href={buildCoverageHref(scope, "all")}
        className={`${TOGGLE_BASE} ${filter === "all" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}`}
        aria-pressed={filter === "all"}
      >
        All
      </Link>
      <Link
        href={buildCoverageHref(scope, "uncovered")}
        className={`${TOGGLE_BASE} ${filter === "uncovered" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}`}
        aria-pressed={filter === "uncovered"}
      >
        No coverage
      </Link>
      <Link
        href={buildCoverageHref(scope, "covered")}
        className={`${TOGGLE_BASE} ${filter === "covered" ? TOGGLE_ACTIVE : TOGGLE_INACTIVE}`}
        aria-pressed={filter === "covered"}
      >
        With coverage
      </Link>
    </div>
  );
}

export default async function AdminCoveragePage({
  searchParams,
}: {
  searchParams: Promise<{ scope?: string; filter?: string }>;
}) {
  const { scope: rawScope, filter: rawFilter } = await searchParams;
  const scope: EventScope = rawScope === "upcoming" ? "upcoming" : "all";
  const filter: CoverageFilter =
    rawFilter === "covered" ? "covered" : rawFilter === "uncovered" ? "uncovered" : "all";

  const [eventRowsRaw, vendorRowsRaw, venueRowsRaw] = await Promise.all([
    getCoverage("EVENT", scope),
    getCoverage("VENDOR"),
    getCoverage("VENUE"),
  ]);

  const zeroEvents = eventRowsRaw.filter((r) => r.blogPostCount === 0).length;
  const zeroVendors = vendorRowsRaw.filter((r) => r.blogPostCount === 0).length;
  const zeroVenues = venueRowsRaw.filter((r) => r.blogPostCount === 0).length;

  const eventRows = applyCoverageView(eventRowsRaw, filter);
  const vendorRows = applyCoverageView(vendorRowsRaw, filter);
  const venueRows = applyCoverageView(venueRowsRaw, filter);

  const description =
    filter === "covered"
      ? "Entities that have at least one published blog post linking to them, sorted by post count descending."
      : filter === "uncovered"
        ? "Entities with zero published blog-post coverage — your writing backlog."
        : "Entities sorted by blog-post coverage ascending — zero-coverage items float to the top. Use this to prioritize what to write about next.";

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
          <FileText className="w-6 h-6 text-amber-dark" />
          Blog Coverage
        </h1>
        <p className="mt-1 text-gray-600 max-w-3xl">{description}</p>
      </div>

      <div className="mb-6 flex flex-wrap items-center gap-4">
        <CoverageFilterToggle scope={scope} filter={filter} />
        <ScopeToggle scope={scope} filter={filter} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-8">
        <div className="rounded-lg border border-stone-100 bg-stone-50 p-4">
          <p className="text-xs uppercase tracking-wide text-stone-600">
            {scope === "upcoming" ? "Upcoming events with 0 posts" : "Events with 0 posts"}
          </p>
          <p className="text-2xl font-bold text-stone-900 mt-1">
            {zeroEvents}{" "}
            <span className="text-sm font-normal text-stone-600">/ {eventRowsRaw.length}</span>
          </p>
        </div>
        <div className="rounded-lg border border-stone-100 bg-stone-50 p-4">
          <p className="text-xs uppercase tracking-wide text-stone-600">Vendors with 0 posts</p>
          <p className="text-2xl font-bold text-stone-900 mt-1">
            {zeroVendors}{" "}
            <span className="text-sm font-normal text-stone-600">/ {vendorRowsRaw.length}</span>
          </p>
        </div>
        <div className="rounded-lg border border-stone-100 bg-stone-50 p-4">
          <p className="text-xs uppercase tracking-wide text-stone-600">Venues with 0 posts</p>
          <p className="text-2xl font-bold text-stone-900 mt-1">
            {zeroVenues}{" "}
            <span className="text-sm font-normal text-stone-600">/ {venueRowsRaw.length}</span>
          </p>
        </div>
      </div>

      <div className="space-y-6">
        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Calendar className="w-5 h-5" />
              {scope === "upcoming" ? "Upcoming Events" : "Events"}
              <span className="text-sm font-normal text-stone-500">({eventRows.length})</span>
            </h2>
          </CardHeader>
          <CardContent>
            <CoverageTable
              rows={eventRows.slice(0, 200)}
              detailPath="/events"
              emptyLabel={emptyLabelFor("event", scope, filter)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <Store className="w-5 h-5" />
              Vendors
              <span className="text-sm font-normal text-stone-500">({vendorRows.length})</span>
            </h2>
          </CardHeader>
          <CardContent>
            <CoverageTable
              rows={vendorRows.slice(0, 200)}
              detailPath="/vendors"
              emptyLabel={emptyLabelFor("vendor", scope, filter)}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
              <MapPin className="w-5 h-5" />
              Venues
              <span className="text-sm font-normal text-stone-500">({venueRows.length})</span>
            </h2>
          </CardHeader>
          <CardContent>
            <CoverageTable
              rows={venueRows.slice(0, 200)}
              detailPath="/venues"
              emptyLabel={emptyLabelFor("venue", scope, filter)}
            />
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function emptyLabelFor(
  kind: "event" | "vendor" | "venue",
  scope: EventScope,
  filter: CoverageFilter,
): string {
  const plural = kind === "event" ? "events" : kind === "vendor" ? "vendors" : "venues";
  if (filter === "covered") {
    return `No ${plural} have blog coverage yet.`;
  }
  if (filter === "uncovered") {
    return `Every ${kind} has at least one blog post — nothing to prioritize.`;
  }
  if (kind === "event" && scope === "upcoming") {
    return "No upcoming events in the database yet.";
  }
  return `No ${plural} to report.`;
}
