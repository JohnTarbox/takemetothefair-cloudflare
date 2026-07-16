/**
 * OPE-191 — "new this week" event selection for the vendor digest (increment 1).
 *
 * Events ADDED in the last 7 days that a vendor could still apply to. The
 * past-date guard (`start_date >= today`) is REQUIRED, not optional: freshly
 * added events can already be in the past, and `lifecycle_status <> 'OCCURRED'`
 * alone let 2 dead events through in testing (per the ticket). We gate on the
 * date directly.
 *
 * TENTATIVE events are included (surfaced as "Dates TBC") — a vendor still wants
 * runway on a show whose dates aren't locked.
 */
import { and, desc, eq, gte, inArray, or } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@takemetothefair/db-schema";
import { parseJsonArray } from "@/types";
import type { VendorDigestEvent } from "@/lib/email/vendor-digest";

const { events, promoters } = schema;
type Db = DrizzleD1Database<typeof schema>;

/** Start-of-day UTC for the past-date guard — an event today still counts. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/** now - 7 days: the "added this week" window floor. */
export function weekAgo(now: Date): Date {
  return new Date(now.getTime() - 7 * 86_400_000);
}

/**
 * Select the vendor-digest events. Curation ordering: soonest-to-apply first
 * (nearest start date), so the strongest time-pressure opportunity leads — a
 * dateless/tentative show sorts last. Caller passes `now` (cron-injected).
 */
export async function selectNewThisWeekEvents(db: Db, now: Date): Promise<VendorDigestEvent[]> {
  const rows = await db
    .select({
      name: events.name,
      slug: events.slug,
      startDate: events.startDate,
      status: events.status,
      lifecycleStatus: events.lifecycleStatus,
      categories: events.categories,
      commercialVendorsAllowed: events.commercialVendorsAllowed,
      estimatedAttendance: events.estimatedAttendance,
      eventScale: events.eventScale,
      indoorOutdoor: events.indoorOutdoor,
      applicationUrl: events.applicationUrl,
      sourceUrl: events.sourceUrl,
      promoterWebsite: promoters.website,
    })
    .from(events)
    .leftJoin(promoters, eq(events.promoterId, promoters.id))
    .where(
      and(
        gte(events.createdAt, weekAgo(now)),
        inArray(events.status, ["APPROVED", "TENTATIVE"]),
        // The required past-date guard. A dateless event (NULL start_date) is
        // allowed through only when it's TENTATIVE (dates not set yet); an
        // APPROVED event with no date is a data gap, not a real opportunity.
        or(
          gte(events.startDate, startOfUtcDay(now)),
          and(eq(events.status, "TENTATIVE"), inArray(events.lifecycleStatus, ["TENTATIVE"]))
        )
      )
    )
    .orderBy(desc(events.startDate))
    .limit(50);

  const mapped: VendorDigestEvent[] = rows.map((r) => ({
    name: r.name,
    slug: r.slug,
    startDate: r.startDate ?? null,
    isTentative: r.status === "TENTATIVE" || r.lifecycleStatus === "TENTATIVE",
    categories: parseJsonArray(r.categories),
    commercialVendorsAllowed: r.commercialVendorsAllowed ?? null,
    estimatedAttendance: r.estimatedAttendance ?? null,
    eventScale: r.eventScale ?? null,
    indoorOutdoor: r.indoorOutdoor ?? null,
    applicationUrl: r.applicationUrl ?? null,
    sourceUrl: r.sourceUrl ?? null,
    promoterWebsite: r.promoterWebsite ?? null,
  }));

  // Curate: soonest real date first; dateless/tentative last. (The SQL ordered
  // by date desc for a stable page; we re-sort ascending here for the lead.)
  return mapped.sort((a, b) => {
    const at = a.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
    const bt = b.startDate?.getTime() ?? Number.POSITIVE_INFINITY;
    return at - bt;
  });
}
