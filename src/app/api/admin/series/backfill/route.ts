export const dynamic = "force-dynamic";
/**
 * EH3 P1 — series-backfill endpoint: dry-run proposal + (flag-gated) commit.
 *
 * POST computes how existing `events` rows cluster into `event_series` (via the
 * pure planner in src/lib/series/group-events.ts) and returns a reviewable
 * proposal. With `dry_run:false` it COMMITS — inserts `event_series` rows, sets
 * `events.series_id`, links the cross-year tombstones, and writes one
 * `admin_actions` audit row.
 *
 * THE COMMIT IS DOUBLE-GATED:
 *   1. `dry_run` defaults true; you must explicitly send `dry_run:false`.
 *   2. The env flag `EH3_P1_BACKFILL_ENABLED` must equal "true". Until an
 *      operator sets it, `dry_run:false` returns 423 Locked and nothing writes.
 * This is the queued-but-disabled state for the REL4-quiet + I1 gate (see
 * docs/eh3-p1-backfill-scoping.md). Commit is fully reversible: it mutates no
 * slugs/dates/vendors; undo = NULL the series_id of the manifest's members and
 * DELETE the created event_series rows (the admin_actions payload IS the undo
 * manifest).
 *
 * Commit policy (pure, tested — src/lib/series/commit-selection.ts):
 *   - skip groups whose series already exists (idempotent re-run)
 *   - HOLD same-year-conflict groups (route to merge_events first)
 *   - HOLD vendor-bearing multi-occurrence groups unless their canonical_slug is
 *     in `confirm_series_slugs` (the roster-fuse risk — the 3–7 events)
 *
 * Dual auth: admin session OR X-Internal-Key (the backfill_event_series MCP tool).
 */
import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { internalKeyMatches } from "@/lib/api-auth";
import { getCloudflareDb, getCloudflareEnv } from "@/lib/cloudflare";
import { events, eventVendors, eventSeries, adminActions } from "@/lib/db/schema";
import { isNull, isNotNull, count, and, eq, inArray, notInArray } from "drizzle-orm";
import { logError } from "@/lib/logger";
import {
  planSeriesBackfill,
  type GroupableEvent,
  type SeriesGroup,
} from "@/lib/series/group-events";
import { selectCommittableGroups } from "@/lib/series/commit-selection";

// EH3 — non-public statuses are NOT occurrences and must be excluded from the
// backfill grouping. Counting a REJECTED duplicate as a group member created
// phantom "same-year conflict" holds (a live event + its already-rejected dupe).
// CANCELLED is terminal too. (DRAFT/PENDING/TENTATIVE stay — they're real
// editions-in-progress that should get a series_id.)
const NON_OCCURRENCE_STATUSES = ["REJECTED", "CANCELLED"] as const;

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

/** D1 batch in chunks — a single batch over thousands of statements is unwise. */
async function runBatched(
  db: ReturnType<typeof getCloudflareDb>,
  statements: unknown[],
  chunkSize = 50
) {
  for (let i = 0; i < statements.length; i += chunkSize) {
    const chunk = statements.slice(i, i + chunkSize);
    if (chunk.length === 0) continue;
    await db.batch(chunk as unknown as Parameters<typeof db.batch>[0]);
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!(await authorize(request))) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as {
      dry_run?: boolean;
      include_all_groups?: boolean;
      confirm_series_slugs?: string[];
    };
    const dryRun = body.dry_run !== false; // default true

    const db = getCloudflareDb();

    if (!dryRun) {
      return await commitBackfill(db, body);
    }

    // ── Dry-run: read-only proposal ────────────────────────────────────────
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
      .where(
        and(isNull(events.mergedInto), notInArray(events.status, [...NON_OCCURRENCE_STATUSES]))
      );

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

    return NextResponse.json({
      dry_run: true,
      events_considered: groupable.length,
      summary: plan.summary,
      needs_manual_confirm: plan.groups
        .filter((g) => g.needsManualConfirm)
        .map(serializeAttentionGroup),
      same_year_conflicts: plan.groups
        .filter((g) => g.sameYearConflict)
        .map(serializeAttentionGroup),
      vendor_review_flags: plan.vendorReviewFlags,
      groups: body.include_all_groups ? plan.groups.map(serializeGroupLean) : undefined,
    });
  } catch (e) {
    const db = getCloudflareDb();
    await logError(db, {
      message: "Error in series backfill endpoint",
      error: e,
      source: "app/api/admin/series/backfill/route.ts:POST",
    });
    return NextResponse.json({ error: "Series backfill failed" }, { status: 500 });
  }
}

/**
 * Flag-gated commit. Inserts series + sets series_id for the committable groups,
 * links cross-year tombstones to their keeper's series, writes one audit row.
 */
async function commitBackfill(
  db: ReturnType<typeof getCloudflareDb>,
  body: { confirm_series_slugs?: string[] }
): Promise<NextResponse> {
  const env = getCloudflareEnv() as unknown as { EH3_P1_BACKFILL_ENABLED?: string };
  if (env.EH3_P1_BACKFILL_ENABLED !== "true") {
    return NextResponse.json(
      {
        error: "EH3 P1 commit is gated (awaiting the REL4-quiet + I1 auto-merge gate).",
        hint: "Set EH3_P1_BACKFILL_ENABLED=true to enable, or re-run with dry_run:true to review.",
      },
      { status: 423 }
    );
  }

  const confirmedSlugs = Array.isArray(body.confirm_series_slugs) ? body.confirm_series_slugs : [];
  const now = new Date();

  // Fuller read: default-source fields, only UNLINKED non-tombstone events
  // (series_id IS NULL keeps re-runs idempotent).
  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      venueId: events.venueId,
      promoterId: events.promoterId,
      startDate: events.startDate,
      completenessScore: events.completenessScore,
      recurrenceRule: events.recurrenceRule,
      description: events.description,
      imageUrl: events.imageUrl,
      categories: events.categories,
      tags: events.tags,
      primaryAudience: events.primaryAudience,
      publicAccess: events.publicAccess,
    })
    .from(events)
    .where(
      and(
        isNull(events.mergedInto),
        isNull(events.seriesId),
        notInArray(events.status, [...NON_OCCURRENCE_STATUSES])
      )
    );

  const vendorRows = await db
    .select({ eventId: eventVendors.eventId, n: count() })
    .from(eventVendors)
    .groupBy(eventVendors.eventId);
  const vendorCountByEvent = new Map<string, number>(vendorRows.map((r) => [r.eventId, r.n]));

  const byId = new Map(rows.map((r) => [r.id, r]));
  const groupable: GroupableEvent[] = rows.map((r) => ({
    id: r.id,
    name: r.name,
    slug: r.slug,
    venueId: r.venueId,
    startDate: r.startDate ?? null,
    completenessScore: r.completenessScore ?? 0,
    vendorLinkCount: vendorCountByEvent.get(r.id) ?? 0,
  }));

  const plan = planSeriesBackfill(groupable);
  const existing = await db.select({ slug: eventSeries.canonicalSlug }).from(eventSeries);
  const { commit, skipped } = selectCommittableGroups(plan.groups, {
    confirmedSlugs,
    existingSeriesSlugs: existing.map((e) => e.slug),
  });

  // ── Phase A: insert series + link members ──────────────────────────────
  const phaseA: unknown[] = [];
  const manifest: Array<{ seriesId: string; canonicalSlug: string; memberIds: string[] }> = [];
  for (const g of commit) {
    const seriesId = crypto.randomUUID();
    const d = byId.get(g.defaultsFromId);
    if (!d) continue; // defensive: defaults member must be in the read set
    phaseA.push(
      db.insert(eventSeries).values({
        id: seriesId,
        canonicalSlug: g.canonicalSlug,
        name: d.name,
        venueId: d.venueId,
        promoterId: d.promoterId,
        recurrenceRule: d.recurrenceRule,
        description: d.description,
        imageUrl: d.imageUrl,
        categories: d.categories ?? "[]",
        tags: d.tags ?? "[]",
        primaryAudience: d.primaryAudience,
        publicAccess: d.publicAccess,
        createdAt: now,
        updatedAt: now,
      })
    );
    const memberIds = g.members.map((m) => m.id);
    phaseA.push(db.update(events).set({ seriesId }).where(inArray(events.id, memberIds)));
    manifest.push({ seriesId, canonicalSlug: g.canonicalSlug, memberIds });
  }
  await runBatched(db, phaseA);

  // ── Phase B: link cross-year tombstones to their keeper's series ───────
  const tombstones = await db
    .select({ id: events.id, keeper: events.mergedInto })
    .from(events)
    .where(and(isNotNull(events.mergedInto), isNull(events.seriesId)));
  const tombstoneLinks: Array<{ tombstone: string; seriesId: string }> = [];
  if (tombstones.length > 0) {
    const keeperIds = [...new Set(tombstones.map((t) => t.keeper).filter((k): k is string => !!k))];
    const keeperSeries =
      keeperIds.length > 0
        ? await db
            .select({ id: events.id, seriesId: events.seriesId })
            .from(events)
            .where(and(inArray(events.id, keeperIds), isNotNull(events.seriesId)))
        : [];
    const keeperSeriesId = new Map(keeperSeries.map((k) => [k.id, k.seriesId as string]));
    const phaseB: unknown[] = [];
    for (const t of tombstones) {
      const sid = t.keeper ? keeperSeriesId.get(t.keeper) : undefined;
      if (sid) {
        phaseB.push(db.update(events).set({ seriesId: sid }).where(eq(events.id, t.id)));
        tombstoneLinks.push({ tombstone: t.id, seriesId: sid });
      }
    }
    await runBatched(db, phaseB);
  }

  // ── Phase C: one audit row (payload = undo manifest) ───────────────────
  const session = await auth();
  await db.insert(adminActions).values({
    action: "event.series.backfill",
    actorUserId: session?.user?.id ?? null,
    targetType: "event_series",
    targetId: "backfill",
    payloadJson: JSON.stringify({
      committed_series: manifest.length,
      linked_members: manifest.reduce((n, m) => n + m.memberIds.length, 0),
      tombstone_links: tombstoneLinks.length,
      confirmed_slugs: confirmedSlugs,
      manifest,
      tombstoneLinks,
      skipped,
    }),
    createdAt: now,
  });

  return NextResponse.json({
    dry_run: false,
    committed_series: manifest.length,
    linked_members: manifest.reduce((n, m) => n + m.memberIds.length, 0),
    tombstone_links: tombstoneLinks.length,
    skipped_counts: skipped.reduce<Record<string, number>>((acc, s) => {
      acc[s.reason] = (acc[s.reason] ?? 0) + 1;
      return acc;
    }, {}),
  });
}
