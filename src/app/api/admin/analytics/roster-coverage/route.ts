export const dynamic = "force-dynamic";
import { NextRequest, NextResponse } from "next/server";
import { and, eq, gte, inArray, isNull, like, or, sql } from "drizzle-orm";
import { isAuthorized } from "@/lib/api-auth";
import { getCloudflareDb } from "@/lib/cloudflare";
import { events, eventVendors } from "@/lib/db/schema";
import { PRODUCER_CLASS_CATEGORIES } from "@takemetothefair/constants";

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
    const unevaluated = byStatus(null); // not yet swept
    const total = hasRoster + needsResearch + noPublicList + partial + unevaluated;

    // researchable = total minus the un-backfillable tail (NO_PUBLIC_LIST):
    // events that genuinely COULD carry a roster.
    const researchable = total - noPublicList;

    // Global queue counts (all events, not just producer-class) — the actual
    // worklist the analyst sweep drains + the un-backfillable tail.
    const queueRows = await db
      .select({ status: events.vendorRosterStatus, n: sql<number>`count(*)` })
      .from(events)
      .where(
        and(
          isNull(events.mergedInto),
          inArray(events.vendorRosterStatus, ["NEEDS_RESEARCH", "NO_PUBLIC_LIST", "PARTIAL"])
        )
      )
      .groupBy(events.vendorRosterStatus);
    const queueOf = (s: string): number => queueRows.find((r) => r.status === s)?.n ?? 0;

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
        unevaluated,
        // Primary metric (playbook §7): share of past producer-class events
        // with a roster. coverageOfResearchablePct excludes the NO_PUBLIC_LIST
        // tail for the "of those that could have one" view.
        coveragePct: pct(hasRoster, total),
        coverageOfResearchablePct: pct(hasRoster, researchable),
      },
      queue: {
        needsResearchTotal: queueOf("NEEDS_RESEARCH"),
        partialTotal: queueOf("PARTIAL"),
        noPublicListTotal: queueOf("NO_PUBLIC_LIST"),
      },
      linksAddedTrend,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ success: false, error: "unknown", message }, { status: 500 });
  }
}
