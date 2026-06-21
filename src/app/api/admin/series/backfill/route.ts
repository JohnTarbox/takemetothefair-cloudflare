export const dynamic = "force-dynamic";
/**
 * EH3 P1 — series-backfill proposal endpoint (DRY-RUN ONLY in this build).
 *
 * POST computes how the existing `events` rows would cluster into `event_series`
 * (via the pure `planSeriesBackfill` in src/lib/series/group-events.ts) and
 * returns a reviewable proposal. It does NOT write: the commit path that inserts
 * `event_series` + sets `events.series_id` is intentionally gated off until the
 * REL4-quiet + I1 auto-merge gate opens (see docs/eh3-p1-backfill-scoping.md).
 * `dry_run:false` returns 423 Locked here; the commit lands as its own reviewed
 * change when the gate opens.
 *
 * Dual auth: admin session OR X-Internal-Key (so the future `backfill_event_series`
 * MCP tool can drive it), matching the dedup-sweep / merge routes.
 *
 * Read-only and safe to poll: selects non-tombstone events + per-event vendor
 * counts, runs the pure planner, returns summary + the attention subsets
 * (needsManualConfirm, sameYearConflict, vendor slug-drift flags). Pass
 * `include_all_groups:true` for the full group dump.
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventVendors } from "@/lib/db/schema";
import { isNull, count } from "drizzle-orm";
import { logError } from "@/lib/logger";
import {
  planSeriesBackfill,
  type GroupableEvent,
  type SeriesGroup,
} from "@/lib/series/group-events";

async function authorize(request: NextRequest): Promise<boolean> {
  if (await internalKeyMatches(request)) return true;
  const session = await auth();
  return session?.user?.role === "ADMIN";
}

/** Trim a member event to the fields an operator needs to triage. */
function serializeMember(e: GroupableEvent) {
  return {
    id: e.id,
    slug: e.slug,
    start_year: e.startDate ? e.startDate.getUTCFullYear() : null,
    vendor_links: e.vendorLinkCount,
  };
}

/** Full detail for an "attention" group (needs-confirm / same-year). */
function serializeAttentionGroup(g: SeriesGroup) {
  return {
    canonical_slug: g.canonicalSlug,
    stem: g.stem,
    venue_id: g.venueId,
    defaults_from_id: g.defaultsFromId,
    same_year_conflict: g.sameYearConflict,
    members: g.members.map(serializeMember),
  };
}

/** Lean shape for the full group dump (counts + ids only). */
function serializeGroupLean(g: SeriesGroup) {
  return {
    canonical_slug: g.canonicalSlug,
    venue_id: g.venueId,
    member_count: g.members.length,
    is_multi_occurrence: g.isMultiOccurrence,
    vendor_bearing: g.vendorBearing,
    needs_manual_confirm: g.needsManualConfirm,
    same_year_conflict: g.sameYearConflict,
    member_ids: g.members.map((m) => m.id),
  };
}

export async function POST(request: NextRequest) {
  try {
    if (!(await authorize(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      dry_run?: boolean;
      include_all_groups?: boolean;
    };
    const dryRun = body.dry_run !== false; // default true

    // Commit path is gated — no write code ships in this build.
    if (!dryRun) {
      return NextResponse.json(
        {
          error: "EH3 P1 commit is gated (awaiting the REL4-quiet + I1 auto-merge gate).",
          hint: "This build is dry-run only. Re-run with dry_run:true to review the proposal.",
        },
        { status: 423 }
      );
    }

    const db = getCloudflareDb();

    // Non-tombstone events only (tombstones link to their keeper's series at
    // commit time, handled separately). Narrow projection — just what the
    // grouper reads.
    const eventRows = await db
      .select({
        id: events.id,
        name: events.name,
        slug: events.slug,
        venueId: events.venueId,
        startDate: events.startDate,
        completenessScore: events.completenessScore,
      })
      .from(events)
      .where(isNull(events.mergedInto));

    // Per-event vendor-link counts in one grouped query (no N+1).
    const vendorRows = await db
      .select({ eventId: eventVendors.eventId, n: count() })
      .from(eventVendors)
      .groupBy(eventVendors.eventId);
    const vendorCountByEvent = new Map<string, number>(vendorRows.map((r) => [r.eventId, r.n]));

    const groupable: GroupableEvent[] = eventRows.map((e) => ({
      id: e.id,
      name: e.name,
      slug: e.slug,
      venueId: e.venueId,
      startDate: e.startDate ?? null,
      completenessScore: e.completenessScore ?? 0,
      vendorLinkCount: vendorCountByEvent.get(e.id) ?? 0,
    }));

    const plan = planSeriesBackfill(groupable);

    const needsConfirm = plan.groups.filter((g) => g.needsManualConfirm);
    const sameYear = plan.groups.filter((g) => g.sameYearConflict);

    return NextResponse.json({
      dry_run: true,
      events_considered: groupable.length,
      summary: plan.summary,
      // The roster-fuse-risk cohort — review these by hand before any commit.
      needs_manual_confirm: needsConfirm.map(serializeAttentionGroup),
      // Likely true duplicates to merge_events (not co-link).
      same_year_conflicts: sameYear.map(serializeAttentionGroup),
      // Slug-drift collisions among vendor groups — possible missed merges.
      vendor_review_flags: plan.vendorReviewFlags,
      groups: body.include_all_groups ? plan.groups.map(serializeGroupLean) : undefined,
    });
  } catch (e) {
    const db = getCloudflareDb();
    await logError(db, {
      message: "Error computing series backfill proposal",
      error: e,
      source: "app/api/admin/series/backfill/route.ts:POST",
    });
    return NextResponse.json({ error: "Failed to compute proposal" }, { status: 500 });
  }
}
