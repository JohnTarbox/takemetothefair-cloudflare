export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, inArray, isNull, like, or, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { rosterResearchTargetWhere, isNonResearchCategory } from "@takemetothefair/db-schema";
import { events, eventVendors } from "@/lib/db/schema";
import { PRODUCER_CLASS_CATEGORIES, ROSTER_EVIDENCE_MIN } from "@takemetothefair/constants";

/**
 * GET /api/admin/analytics/roster-coverage
 *
 * OPE-13 Part 3 — vendor-roster coverage metric. Reports, for PAST producer-
 * class events (the events worth backfilling), the share that have a roster
 * attached, plus the size of the research queue, the un-backfillable tail, and
 * an 8-week links-added trend. Auth: admin session OR X-Internal-Key (MCP).
 *
 * "Past producer-class" = lifecycle_status OCCURRED + categories ∈
 * PRODUCER_CLASS_CATEGORIES (matched against the JSON `categories` array),
 * excluding merge tombstones. OCCURRED is used (not raw endDate) so the
 * denominator matches exactly the rows the just-occurred sweep enqueues.
 */
export async function GET(request: NextRequest) {
  if (!(await isAuthorized(request))) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const db = getCloudflareDb();
    const now = new Date();

    // Producer-class match: categories is a JSON array of quoted values, so
    // match `%"Home Show"%` to avoid substring bleed across category names.
    const producerCond = or(
      ...PRODUCER_CLASS_CATEGORIES.map((c) => like(events.categories, `%"${c}"%`))
    );
    const pastProducer = and(
      eq(events.lifecycleStatus, "OCCURRED"),
      isNull(events.mergedInto),
      producerCond
    );

    // Status breakdown among past producer-class events.
    const statusRows = await db
      .select({ status: events.vendorRosterStatus, n: sql<number>`count(*)` })
      .from(events)
      .where(pastProducer)
      .groupBy(events.vendorRosterStatus);

    const byStatus = (s: string | null): number => statusRows.find((r) => r.status === s)?.n ?? 0;

    const hasRoster = byStatus("HAS_ROSTER");
    const needsResearch = byStatus("NEEDS_RESEARCH");
    const noPublicList = byStatus("NO_PUBLIC_LIST");
    const partial = byStatus("PARTIAL");
    // OPE-498 — a public roster we cannot reach with a server-side fetch.
    const needsRenderedFetch = byStatus("NEEDS_RENDERED_FETCH");
    // OPE-527 — links we hold but nobody researched or attributed. Counted
    // SEPARATELY from hasRoster on purpose: folding them in makes coveragePct
    // read as "we have this many verified rosters" when part of it is "we have
    // this many piles of links". Coverage is a claim about knowledge, and this
    // bucket is precisely the rows where we do not have it.
    const hasLinksUnverified = byStatus("HAS_LINKS_UNVERIFIED");
    const unevaluated = byStatus(null); // not yet swept
    const total =
      hasRoster +
      needsResearch +
      noPublicList +
      partial +
      needsRenderedFetch +
      hasLinksUnverified +
      unevaluated;

    // researchable = total minus the tails we cannot backfill with the fetch we
    // have. NO_PUBLIC_LIST has no list at all; NEEDS_RENDERED_FETCH has one we
    // cannot see without a rendering fetcher.
    //
    // ⚠️ The two are NOT the same tail and must not be merged: NO_PUBLIC_LIST is
    // permanent, NEEDS_RENDERED_FETCH becomes researchable the day a rendered
    // fetch exists. Collapsing them would hide the size of that opportunity —
    // Guilford alone is 150 uncaptured makers on a 175-exhibitor show.
    const researchable = total - noPublicList - needsRenderedFetch;

    // Global queue counts (all events, not just producer-class) — the actual
    // worklist the analyst sweep drains + the un-backfillable tail.
    // OPE-528 — the queue now counts only rows a drain could actually close.
    //
    // It previously counted every row in a queue status, including 8 REJECTED
    // events (a decision already taken) and 128 weekly farmers-market
    // occurrences (which do not publish exhibitor rosters, so they can never
    // reach a terminal status and the recurrence mints more every week).
    // Because the drain sorts `end_date_desc`, those were also the rows at the
    // TOP of the worklist.
    //
    // `rosterResearchTargetWhere` is shared with the MCP `list_all_events`
    // filter so the two surfaces cannot drift — they differed by exactly 3
    // (merge tombstones) with no stated rule until this was one definition.
    const queueStatuses = [
      "NEEDS_RESEARCH",
      "NO_PUBLIC_LIST",
      "PARTIAL",
      "NEEDS_RENDERED_FETCH",
    ] as const;
    const queueRows = await db
      .select({ status: events.vendorRosterStatus, n: sql<number>`count(*)` })
      .from(events)
      .where(
        and(rosterResearchTargetWhere(), inArray(events.vendorRosterStatus, [...queueStatuses]))
      )
      .groupBy(events.vendorRosterStatus);

    // EXCLUDED, NOT DISCARDED. Reported as their own totals so the queue
    // shrinking is legible as a definition change rather than as a drain that
    // happened overnight. A number that silently drops is indistinguishable
    // from a queue that emptied — the failure this rail keeps hitting.
    const [excludedRows] = await db
      .select({
        nonApproved: sql<number>`sum(case when ${events.status} <> 'APPROVED' and ${events.mergedInto} is null then 1 else 0 end)`,
        tombstoned: sql<number>`sum(case when ${events.mergedInto} is not null then 1 else 0 end)`,
        recurringMarket: sql<number>`sum(case when ${events.mergedInto} is null and ${events.status} = 'APPROVED' and ${isNonResearchCategory()} then 1 else 0 end)`,
      })
      .from(events)
      .where(inArray(events.vendorRosterStatus, [...queueStatuses]));
    const queueOf = (s: string): number => queueRows.find((r) => r.status === s)?.n ?? 0;

    // OPE-547 — the NULL population, reported as a first-class total.
    //
    // Until now a NULL vendor_roster_status was counted by NOTHING. The
    // `producerClass` block below computes `unevaluated` from byStatus(null),
    // but its denominator is PAST + producer-class + OCCURRED, so it read 0
    // while 651 research targets carried no status at all. The `queue` block
    // uses inArray over the four queue statuses, and NULL is never in an
    // inArray — so it could not see them either.
    //
    // The effect was a dashboard on which `unevaluated: 0` sat next to a
    // 37-vendor home show with no roster status, and a drain could set three
    // terminal verdicts and move `needsResearchTotal` by zero. Measured
    // 2026-08-26, among APPROVED non-tombstoned non-farmers-market events:
    //
    //     past + OCCURRED ..... 499 rows,   0 NULL   <- the sweep works
    //     past + TENTATIVE .... 126 rows, 123 NULL   <- Pass 3 never saw them
    //     upcoming ............ 483 rows, 483 NULL   <- legitimately not yet due
    //
    // Past and upcoming are split because they mean opposite things. A past
    // NULL row is a gap: the event is over and nothing was ever decided. An
    // upcoming NULL row is correct: there is nothing to research yet. Folding
    // them into one number would make the honest 483 hide the 123 that matter,
    // which is the same mistake this field exists to undo.
    const rosterGradeLinks = sql<number>`(
      SELECT COUNT(*) FROM ${eventVendors}
      WHERE ${eventVendors.eventId} = ${events.id}
        AND ${eventVendors.status} IN ('CONFIRMED', 'APPROVED')
        AND (${eventVendors.participationType} IS NULL
             OR ${eventVendors.participationType} <> 'SPONSOR_ONLY')
    )`;
    const nowSecs = Math.floor(now.getTime() / 1000);
    const isOver = sql`${events.endDate} IS NOT NULL AND ${events.endDate} < ${nowSecs}`;
    const [unevalRow] = await db
      .select({
        total: sql<number>`count(*)`,
        past: sql<number>`sum(case when ${isOver} then 1 else 0 end)`,
        upcoming: sql<number>`sum(case when ${events.endDate} is not null and not (${isOver}) then 1 else 0 end)`,
        undated: sql<number>`sum(case when ${events.endDate} is null then 1 else 0 end)`,
        // The "finished work with no receipt" bucket — rows already holding
        // roster-grade links that no status records. These are what a drain
        // would otherwise research from scratch.
        withRosterGradeLinks: sql<number>`sum(case when ${rosterGradeLinks} >= ${ROSTER_EVIDENCE_MIN} then 1 else 0 end)`,
        withSomeLinks: sql<number>`sum(case when ${rosterGradeLinks} > 0 then 1 else 0 end)`,
      })
      .from(events)
      .where(and(rosterResearchTargetWhere(), isNull(events.vendorRosterStatus)));

    // 8-week links-added trend. Bucket in JS (Drizzle returns Date objects, so
    // we sidestep any epoch-unit ambiguity in the stored integer timestamps).
    const WEEKS = 8;
    const since = new Date(now.getTime() - WEEKS * 7 * 24 * 60 * 60 * 1000);
    const linkRows = await db
      .select({ createdAt: eventVendors.createdAt })
      .from(eventVendors)
      .where(gte(eventVendors.createdAt, since));

    const buckets = new Map<string, number>();
    for (const r of linkRows) {
      if (!r.createdAt) continue;
      const d = new Date(r.createdAt);
      // Monday-anchored week start, as YYYY-MM-DD.
      const day = (d.getUTCDay() + 6) % 7; // 0 = Monday
      const monday = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
      const key = monday.toISOString().slice(0, 10);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }
    const linksAddedTrend = Array.from(buckets.entries())
      .map(([weekStart, count]) => ({ weekStart, count }))
      .sort((a, b) => a.weekStart.localeCompare(b.weekStart));

    const pct = (num: number, den: number): number =>
      den === 0 ? 0 : Math.round((num / den) * 1000) / 10; // one decimal place

    return NextResponse.json({
      success: true,
      generatedAt: now.toISOString(),
      producerClass: {
        total,
        hasRoster,
        needsResearch,
        noPublicList,
        partial,
        // OPE-527 — see the comment at the computation. Reported alongside
        // hasRoster rather than inside it.
        hasLinksUnverified,
        unevaluated,
        // Primary metric (playbook §7): share of past producer-class events
        // with a roster. coverageOfResearchablePct excludes the NO_PUBLIC_LIST
        // tail for the "of those that could have one" view.
        // OPE-527 — coveragePct counts VERIFIED rosters only. The second
        // figure adds the unverified pile, so the gap between the two is
        // readable at a glance: it is the amount of "coverage" that is really
        // just links nobody checked.
        coveragePct: pct(hasRoster, total),
        coverageOfResearchablePct: pct(hasRoster, researchable),
        coverageInclUnverifiedPct: pct(hasRoster + hasLinksUnverified, total),
      },
      // OPE-547 — see the computation above. Deliberately a SIBLING of `queue`
      // rather than a field inside it: these rows are not in the queue, and
      // nesting them there would imply a drain could close them today.
      unevaluated: {
        total: unevalRow?.total ?? 0,
        past: unevalRow?.past ?? 0,
        upcoming: unevalRow?.upcoming ?? 0,
        undated: unevalRow?.undated ?? 0,
        withRosterGradeLinks: unevalRow?.withRosterGradeLinks ?? 0,
        withSomeLinks: unevalRow?.withSomeLinks ?? 0,
        rosterGradeLinkThreshold: ROSTER_EVIDENCE_MIN,
      },
      queue: {
        needsResearchTotal: queueOf("NEEDS_RESEARCH"),
        // OPE-498 — `partialTotal` now means what it says: rows a run can
        // actually resume. Before this it reported 5 rows that were as complete
        // as a server-side fetch could make them.
        partialTotal: queueOf("PARTIAL"),
        noPublicListTotal: queueOf("NO_PUBLIC_LIST"),
        needsRenderedFetchTotal: queueOf("NEEDS_RENDERED_FETCH"),
        // OPE-527 — not re-enqueued by the sweep (we already hold the links),
        // but targetable by a drain that wants to attribute them.
        hasLinksUnverifiedTotal: queueOf("HAS_LINKS_UNVERIFIED"),
        // OPE-528 — what the totals above deliberately leave out. Present so
        // the exclusion is auditable from the same response that applies it.
        excluded: {
          nonApproved: excludedRows?.nonApproved ?? 0,
          tombstoned: excludedRows?.tombstoned ?? 0,
          recurringMarket: excludedRows?.recurringMarket ?? 0,
        },
      },
      linksAddedTrend,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}
