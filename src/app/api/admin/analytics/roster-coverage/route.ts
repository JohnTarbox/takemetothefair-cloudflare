export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import {
  rosterResearchTargetWhere,
  isNonResearchCategory,
  pastProducerClassWhere,
  pastNonProducerClassWhere,
  hasNoCategories,
} from "@takemetothefair/db-schema";
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
    // OPE-713 — the predicate now lives in `@takemetothefair/db-schema`
    // alongside `rosterResearchTargetWhere`, for the reason `vendorSearchWhere`
    // was extracted (OPE-632/OPE-566): a rule that decides a published metric's
    // denominator, and that nothing outside this route could run, is a rule
    // readers will infer wrongly from its outcomes. One did — see the note at
    // `producerClassExcluded` below.
    const pastProducer = pastProducerClassWhere(PRODUCER_CLASS_CATEGORIES);

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

    // OPE-547 follow-up — see the note at `hasLinksUnverifiedTotal`.
    const [hasLinksUnverifiedRow] = await db
      .select({ n: sql<number>`count(*)` })
      .from(events)
      .where(
        and(rosterResearchTargetWhere(), eq(events.vendorRosterStatus, "HAS_LINKS_UNVERIFIED"))
      );

    // ── OPE-713: why the drain's biggest wins do not move coveragePct ──────
    //
    // Measured 2026-08-31: a roster pass added 530 vendor links and took 11
    // events to a terminal status, and `producerClass.coveragePct` moved 0.4pp.
    // The two largest rosters it completed were invisible to the metric:
    //
    //   Kill Tide Arts & Craft Festival 2026    93 exhibitors  categories []
    //   Nauset Summer Craft Festival 2026       81 exhibitors  categories []
    //   Great Falls Balloon Festival 2026       58 exhibitors  ["Festival","Community Event"]
    //   Quechee Scottish Games & Festival 2026  37 exhibitors  ["Festival","Cultural Festival",...]
    //
    // The ticket reasonably suspected `event_scale`, because a LARGE show
    // counted while two null-scale shows did not. Scale is not in this
    // predicate at all. Membership keys on `categories`, and the LARGE show
    // that counted carries "Craft Fair" while the two that did not carry
    // nothing. The confusion is the point: the denominator was not legible
    // from the outside, so a reader inferred the wrong rule from the outcomes.
    //
    // These are TWO different problems that look like one:
    //
    //   1. Empty `categories` is a DATA gap. "Craft Festival" is not a category
    //      value; these rows carry no categories at all, so no widening of the
    //      list would reach them. Fixing the metric cannot fix them, and
    //      widening it to admit uncategorised rows would drag in every
    //      uncategorised event in the table.
    //
    //   2. "Festival" / "Community Event" is the definition WORKING. Producer
    //      class deliberately means "shows that publish a web exhibitor
    //      directory worth backfilling". But these two published rosters of 58
    //      and 37 — so the premise is at least partly falsified, and that is a
    //      judgement for an operator, not something to quietly widen.
    //
    // So `producerClass` is left exactly as it is. Rewriting a published series
    // would silently restate every past reading of it, and this rail has been
    // bitten by a number that changed meaning without saying so. Instead the
    // excluded population is reported as its own sibling — the same doctrine as
    // `unevaluated` (OPE-547) and the queue's `excluded` block above: EXCLUDED,
    // NOT DISCARDED.
    const pastNonProducer = pastNonProducerClassWhere(PRODUCER_CLASS_CATEGORIES);
    const [nonProducerRow] = await db
      .select({
        total: sql<number>`count(*)`,
        hasRoster: sql<number>`sum(case when ${events.vendorRosterStatus} = 'HAS_ROSTER' then 1 else 0 end)`,
        // The drain's invisible output: rows already holding roster-grade links
        // that the primary coverage number will never count.
        withRosterGradeLinks: sql<number>`sum(case when ${rosterGradeLinks} >= ${ROSTER_EVIDENCE_MIN} then 1 else 0 end)`,
        // Split by CAUSE, because the two need opposite remedies — one is a
        // data fix, the other a definition decision.
        emptyCategories: sql<number>`sum(case when ${hasNoCategories()} then 1 else 0 end)`,
        emptyCategoriesWithRosterGradeLinks: sql<number>`sum(case when ${hasNoCategories()} and ${rosterGradeLinks} >= ${ROSTER_EVIDENCE_MIN} then 1 else 0 end)`,
      })
      .from(events)
      .where(pastNonProducer);

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
      // OPE-713 — what the producer-class denominator cannot see, and why.
      // Sibling, not nested: these rows are not producer-class and pretending
      // otherwise is the thing this block exists to prevent.
      producerClassExcluded: {
        total: nonProducerRow?.total ?? 0,
        hasRoster: nonProducerRow?.hasRoster ?? 0,
        withRosterGradeLinks: nonProducerRow?.withRosterGradeLinks ?? 0,
        // Cause 1 — a DATA gap. Categorise the event and it joins the
        // denominator; no metric change can reach these.
        emptyCategories: nonProducerRow?.emptyCategories ?? 0,
        emptyCategoriesWithRosterGradeLinks:
          nonProducerRow?.emptyCategoriesWithRosterGradeLinks ?? 0,
      },
      // OPE-713 — the number a roster drain can actually move. Same past +
      // OCCURRED + non-tombstone frame, with the category filter dropped, so a
      // pass can see its own output without `producerClass` changing meaning.
      // Report BOTH: the gap between them is the size of the question in
      // `producerClassExcluded`.
      allPastOccurred: {
        total: total + (nonProducerRow?.total ?? 0),
        hasRoster: hasRoster + (nonProducerRow?.hasRoster ?? 0),
        coveragePct: pct(
          hasRoster + (nonProducerRow?.hasRoster ?? 0),
          total + (nonProducerRow?.total ?? 0)
        ),
      },
      // OPE-713 — the predicate, returned rather than described, so a caller
      // can tell IN ADVANCE whether its target will register instead of
      // inferring the rule from which of its writes counted.
      producerClassDefinition: {
        lifecycleStatus: "OCCURRED",
        excludesMergeTombstones: true,
        categories: [...PRODUCER_CLASS_CATEGORIES],
        note: "Membership keys on the `categories` JSON array. event_scale is NOT part of this predicate.",
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
        //
        // OPE-547 follow-up — this read `queueOf("HAS_LINKS_UNVERIFIED")`, and
        // `queueOf` looks in `queueRows`, which is filtered by
        // `inArray(vendorRosterStatus, queueStatuses)` — an array that does NOT
        // contain HAS_LINKS_UNVERIFIED. So it was structurally incapable of
        // returning anything but 0.
        //
        // It went unnoticed because prod held ZERO rows in that status from the
        // day OPE-527 created it until drizzle/0236 stamped 8 this afternoon —
        // so 0 was accidentally the right answer for as long as anyone looked.
        // The field's own comment calls these rows "targetable by a drain",
        // which is precisely the claim a permanent 0 makes false.
        //
        // Counted directly against the same research-target definition the rest
        // of this block uses, rather than by widening `queueStatuses`: that
        // array defines what the QUEUE is, `excluded` is computed from it too,
        // and this status is deliberately not in the queue.
        hasLinksUnverifiedTotal: hasLinksUnverifiedRow?.n ?? 0,
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
