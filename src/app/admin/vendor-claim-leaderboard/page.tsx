/**
 * Probability-to-claim vendor leaderboard (analyst A6, 2026-05-29).
 *
 * Of ~2,545 vendors, only a small contactable subset (~29 at the time
 * the analyst spec'd this) has both contact_email and is unclaimed.
 * Within that subset, some are dramatically higher-leverage than
 * others — a vendor that participates in 30 events and gets 200
 * /vendors/<slug> views a month is a much better outreach target than
 * one with 1 event and 0 views.
 *
 * This page ranks the contactable-and-unclaimed set by a composite
 * score combining four signals, then surfaces it as a sortable
 * table so the operator can work down the list instead of cherry-
 * picking.
 *
 * Score components (each 0..1 after normalization, weighted sum):
 *
 *   - event_vendors row count  weight 0.35  evidence of activity
 *   - /vendors/<slug> view count weight 0.30  evidence of demand
 *   - completeness_score        weight 0.20  already-have-the-content signal
 *   - has-website + has-phone   weight 0.15  contactability beyond email
 *
 * vendor-type fit (from analyst spec) deferred — fit-matching would
 * need a separate fit-rules pass and a target event/segment context
 * the page doesn't have today. The current signal set is enough to
 * triage the ~29-vendor contactable list into priority order without
 * the additional context.
 *
 * Server component, edge runtime, no client interactivity — same
 * pattern as /admin/source-quality + /admin/blog + /admin/stuck-urls.
 */

import Link from "next/link";
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { getCloudflareDb } from "@/lib/cloudflare";
import { analyticsEvents, eventVendors, vendors, vendorOutreachAttempts } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { LogOutreachButton } from "@/components/admin/log-outreach-button";

export const runtime = "edge";
export const revalidate = 300;

const WEIGHT_EVENT_COUNT = 0.35;
const WEIGHT_VIEW_COUNT = 0.3;
const WEIGHT_COMPLETENESS = 0.2;
const WEIGHT_CONTACT_RICHNESS = 0.15;

interface LeaderboardRow {
  id: string;
  slug: string;
  businessName: string;
  contactEmail: string;
  contactPhone: string | null;
  website: string | null;
  state: string | null;
  completenessScore: number;
  eventCount: number;
  viewCount: number;
  /** Composite 0..1; rendered as 0..100. Sort key. */
  score: number;
  /** Per-component contributions so the operator can see *why* the
   *  vendor scored where it did — same shape lets us spot-check the
   *  ranking ("why is X above Y?") without re-running the math. */
  breakdown: {
    eventCount: number;
    viewCount: number;
    completeness: number;
    contactRichness: number;
  };
  /** Outreach history populated by phase 4 (analyst J1). Lets the
   *  operator avoid re-attempting an already-contacted vendor and see
   *  what happened last time. */
  outreachCount: number;
  lastOutreachAt: Date | null;
  lastOutreachOutcome: string | null;
}

async function loadLeaderboard(): Promise<LeaderboardRow[]> {
  const db = getCloudflareDb();

  // Phase 1: contactable + unclaimed + not deleted. Trimming the
  // long-tail of 2k+ uncontactable vendors at the SQL boundary keeps
  // the join below bounded.
  const contactable = await db
    .select({
      id: vendors.id,
      slug: vendors.slug,
      businessName: vendors.businessName,
      contactEmail: vendors.contactEmail,
      contactPhone: vendors.contactPhone,
      website: vendors.website,
      state: vendors.state,
      completenessScore: vendors.completenessScore,
    })
    .from(vendors)
    .where(
      and(
        isNotNull(vendors.contactEmail),
        ne(vendors.contactEmail, ""),
        eq(vendors.claimed, false),
        isNull(vendors.deletedAt)
      )
    );

  if (contactable.length === 0) return [];

  const vendorIds = contactable.map((v) => v.id);
  const vendorSlugs = contactable.map((v) => v.slug as unknown as string);

  // Phase 2: event participation counts. One GROUP BY on the join
  // table; the ~29-row vendor set times a few hundred event_vendors
  // rows is bounded, no LIMIT needed.
  const eventCountRows = await db
    .select({
      vendorId: eventVendors.vendorId,
      count: sql<number>`COUNT(*)`,
    })
    .from(eventVendors)
    .where(inArray(eventVendors.vendorId, vendorIds))
    .groupBy(eventVendors.vendorId);
  const eventCountByVendor = new Map(eventCountRows.map((r) => [r.vendorId, Number(r.count ?? 0)]));

  // Phase 3: detail-page view counts. analytics_events stores
  // view_vendor_detail beacons (src/lib/analytics.ts:44) with
  // properties.vendorSlug. json_extract on the SQLite side filters
  // first, then COUNT() per slug. json_valid() guards against the
  // malformed-properties row poisoning the query.
  const viewCountRows = await db
    .select({
      slug: sql<string>`json_extract(${analyticsEvents.properties}, '$.vendorSlug')`,
      count: sql<number>`COUNT(*)`,
    })
    .from(analyticsEvents)
    .where(
      and(
        eq(analyticsEvents.eventName, "view_vendor_detail"),
        sql`json_valid(${analyticsEvents.properties})`,
        sql`json_extract(${analyticsEvents.properties}, '$.vendorSlug') IN (${sql.join(
          vendorSlugs.map((s) => sql`${s}`),
          sql`, `
        )})`
      )
    )
    .groupBy(sql`json_extract(${analyticsEvents.properties}, '$.vendorSlug')`);
  const viewCountBySlug = new Map(viewCountRows.map((r) => [r.slug, Number(r.count ?? 0)]));

  // Phase 4 (analyst J1, 2026-05-29 PM): outreach attempts per vendor.
  // Count of attempts + last attempt timestamp + last outcome surface on
  // the leaderboard so the operator doesn't re-attempt a vendor that
  // was already contacted, and sees what happened last time. Once
  // outcomes accumulate, a prior_claim_outcome_signal can roll into the
  // composite score (analyst's future note); v1 just surfaces the
  // history without scoring it.
  const outreachRows = await db
    .select({
      vendorId: vendorOutreachAttempts.vendorId,
      count: sql<number>`COUNT(*)`,
      lastAttemptAt: sql<number>`MAX(${vendorOutreachAttempts.attemptStartedAt})`,
    })
    .from(vendorOutreachAttempts)
    .where(inArray(vendorOutreachAttempts.vendorId, vendorIds))
    .groupBy(vendorOutreachAttempts.vendorId);
  const outreachByVendor = new Map(
    outreachRows.map((r) => [
      r.vendorId,
      {
        count: Number(r.count ?? 0),
        lastAttemptAt: r.lastAttemptAt ? new Date(Number(r.lastAttemptAt) * 1000) : null,
      },
    ])
  );

  // Secondary lookup: outcome of each vendor's MOST-RECENT attempt.
  // Subquery would be cleaner in raw SQL but Drizzle's grouped-then-
  // joined shape is awkward; two-pass is fine at ~29 vendors.
  const lastOutcomeRows =
    vendorIds.length === 0
      ? []
      : await db
          .select({
            vendorId: vendorOutreachAttempts.vendorId,
            outcome: vendorOutreachAttempts.outcome,
            attemptStartedAt: vendorOutreachAttempts.attemptStartedAt,
          })
          .from(vendorOutreachAttempts)
          .where(inArray(vendorOutreachAttempts.vendorId, vendorIds))
          .orderBy(desc(vendorOutreachAttempts.attemptStartedAt));
  const lastOutcomeByVendor = new Map<string, string | null>();
  for (const row of lastOutcomeRows) {
    // First row per vendor wins because we ordered DESC by attempt time.
    if (!lastOutcomeByVendor.has(row.vendorId)) {
      lastOutcomeByVendor.set(row.vendorId, row.outcome ?? null);
    }
  }

  // Normalize each signal to 0..1 against the max in the set. Z-score
  // would be technically nicer but the leaderboard is for triage; a
  // proportional fraction is more intuitive when the operator reads
  // the breakdown.
  const maxEvents = Math.max(...[...eventCountByVendor.values(), 1]);
  const maxViews = Math.max(...[...viewCountBySlug.values(), 1]);

  const rows: LeaderboardRow[] = contactable.map((v) => {
    const events = eventCountByVendor.get(v.id) ?? 0;
    const views = viewCountBySlug.get(v.slug as unknown as string) ?? 0;
    const contactBeyondEmail =
      (v.contactPhone && v.contactPhone.trim() ? 0.5 : 0) +
      (v.website && v.website.trim() ? 0.5 : 0);

    const norm = {
      eventCount: maxEvents > 0 ? events / maxEvents : 0,
      viewCount: maxViews > 0 ? views / maxViews : 0,
      completeness: (v.completenessScore ?? 0) / 100,
      contactRichness: contactBeyondEmail,
    };
    const score =
      norm.eventCount * WEIGHT_EVENT_COUNT +
      norm.viewCount * WEIGHT_VIEW_COUNT +
      norm.completeness * WEIGHT_COMPLETENESS +
      norm.contactRichness * WEIGHT_CONTACT_RICHNESS;
    const outreach = outreachByVendor.get(v.id);
    return {
      id: v.id,
      slug: v.slug,
      businessName: v.businessName,
      contactEmail: v.contactEmail!,
      contactPhone: v.contactPhone,
      website: v.website,
      state: v.state,
      completenessScore: v.completenessScore ?? 0,
      eventCount: events,
      viewCount: views,
      score,
      breakdown: norm,
      outreachCount: outreach?.count ?? 0,
      lastOutreachAt: outreach?.lastAttemptAt ?? null,
      lastOutreachOutcome: lastOutcomeByVendor.get(v.id) ?? null,
    };
  });

  // Highest score first; stable tiebreaker on businessName.
  return rows.sort(
    (a, b) =>
      b.score - a.score ||
      a.businessName.localeCompare(b.businessName, undefined, { sensitivity: "base" })
  );
}

function scoreBadgeClasses(score: number): string {
  if (score >= 0.6) return "bg-green-50 text-green-800 border-green-300";
  if (score >= 0.3) return "bg-amber-50 text-amber-800 border-amber-300";
  return "bg-gray-50 text-gray-600 border-gray-200";
}

// Outcome chip colors mirror the operator's mental model: claimed=green,
// rejected=neutral (not a problem to chase up; just no-go for now),
// no_response/sent/opened=amber (in-flight, retry-able), bounced=red
// (broken channel). analyst J1 — same color language we use in
// /admin/inbound-emails for reply_kind chips.
function outcomeBadgeClasses(outcome: string): string {
  switch (outcome) {
    case "claimed":
      return "bg-green-50 text-green-800 border-green-300";
    case "rejected":
      return "bg-gray-50 text-gray-600 border-gray-200";
    case "bounced":
      return "bg-red-50 text-red-800 border-red-300";
    case "replied":
      return "bg-blue-50 text-blue-800 border-blue-200";
    case "sent":
    case "opened":
    case "no_response":
    default:
      return "bg-amber-50 text-amber-800 border-amber-200";
  }
}

export default async function VendorClaimLeaderboardPage() {
  const rows = await loadLeaderboard();
  const totalRows = rows.length;

  return (
    <div className="max-w-7xl mx-auto p-6 space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">Probability-to-claim leaderboard</h1>
        <p className="text-sm text-gray-600 mt-1">
          Unclaimed vendors with <code>contact_email</code> set, ranked by composite of
          event-participation count, /vendors/&lt;slug&gt; view count, completeness, and
          contact-channel richness (phone + website). The pool is small (~29 today); the ranking
          turns judgment-based outreach into a worked list.
        </p>
      </header>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        <Stat label="Contactable + unclaimed" value={totalRows} />
        <Stat
          label="Above 0.6 score"
          value={rows.filter((r) => r.score >= 0.6).length}
          accent="green"
        />
        <Stat
          label="Avg completeness"
          value={
            totalRows > 0
              ? Math.round(rows.reduce((a, r) => a + r.completenessScore, 0) / totalRows)
              : 0
          }
          suffix="/100"
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-sm font-semibold">Ranked vendors</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {rows.length === 0 ? (
            <p className="p-6 text-sm text-gray-500">
              No vendors match the contactable-and-unclaimed filter. Likely no vendors have{" "}
              <code>contact_email</code> set yet, or all are claimed.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-50 border-b border-gray-200 text-left text-gray-600">
                  <tr>
                    <th className="px-4 py-2 font-medium">#</th>
                    <th className="px-4 py-2 font-medium">vendor</th>
                    <th className="px-4 py-2 font-medium">contact</th>
                    <th className="px-4 py-2 font-medium text-right">events</th>
                    <th className="px-4 py-2 font-medium text-right">views</th>
                    <th className="px-4 py-2 font-medium text-right">complete</th>
                    <th className="px-4 py-2 font-medium text-right">score</th>
                    <th className="px-4 py-2 font-medium">last outreach</th>
                    <th className="px-4 py-2 font-medium text-right">log</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r, i) => (
                    <tr key={r.id} className="border-b border-gray-100 hover:bg-gray-50">
                      <td className="px-4 py-2 text-gray-500 tabular-nums">{i + 1}</td>
                      <td className="px-4 py-2">
                        <Link
                          href={`/vendors/${r.slug}`}
                          target="_blank"
                          rel="noreferrer"
                          className="text-blue-600 hover:underline font-medium"
                        >
                          {r.businessName}
                        </Link>
                        <div className="text-xs text-gray-500 font-mono">{r.slug}</div>
                        {r.state && <div className="text-xs text-gray-500">{r.state}</div>}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-600">
                        <div className="font-mono">{r.contactEmail}</div>
                        {r.contactPhone && <div>{r.contactPhone}</div>}
                        {r.website && (
                          <a
                            href={r.website}
                            target="_blank"
                            rel="noreferrer"
                            className="text-blue-600 hover:underline truncate inline-block max-w-[200px]"
                          >
                            {r.website.replace(/^https?:\/\//, "")}
                          </a>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                        {r.eventCount}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                        {r.viewCount}
                      </td>
                      <td className="px-4 py-2 text-right tabular-nums text-gray-700">
                        {r.completenessScore}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <span
                          title={`evt ${(r.breakdown.eventCount * WEIGHT_EVENT_COUNT * 100).toFixed(1)} + view ${(r.breakdown.viewCount * WEIGHT_VIEW_COUNT * 100).toFixed(1)} + complete ${(r.breakdown.completeness * WEIGHT_COMPLETENESS * 100).toFixed(1)} + contact ${(r.breakdown.contactRichness * WEIGHT_CONTACT_RICHNESS * 100).toFixed(1)}`}
                          className={`inline-block px-2 py-0.5 rounded text-xs font-medium border tabular-nums ${scoreBadgeClasses(r.score)}`}
                        >
                          {(r.score * 100).toFixed(1)}
                        </span>
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-600">
                        {r.outreachCount === 0 ? (
                          <span className="text-gray-400">never</span>
                        ) : (
                          <span>
                            {r.outreachCount}× · last{" "}
                            {r.lastOutreachAt ? r.lastOutreachAt.toISOString().slice(0, 10) : "?"}
                            {r.lastOutreachOutcome && (
                              <span
                                className={`ml-1 inline-block px-1 py-0.5 rounded text-[10px] font-medium border ${outcomeBadgeClasses(r.lastOutreachOutcome)}`}
                              >
                                {r.lastOutreachOutcome}
                              </span>
                            )}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2 text-right">
                        <LogOutreachButton vendorId={r.id} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="text-xs text-gray-500">
        Score weights: events {WEIGHT_EVENT_COUNT * 100}%, views {WEIGHT_VIEW_COUNT * 100}%,
        completeness {WEIGHT_COMPLETENESS * 100}%, contact richness {WEIGHT_CONTACT_RICHNESS * 100}
        %. Hover any score for the per-component breakdown. Normalization is proportional-to-max
        within the displayed cohort — a vendor at the top of today&apos;s list might rank lower
        tomorrow if a higher-engagement contactable vendor appears.
      </p>
    </div>
  );
}

function Stat({
  label,
  value,
  suffix,
  accent,
}: {
  label: string;
  value: number;
  suffix?: string;
  accent?: "green";
}) {
  const cls = accent === "green" ? "text-green-700" : "text-gray-900";
  return (
    <Card>
      <CardContent className="p-4">
        <p className="text-xs text-gray-500">{label}</p>
        <p className={`text-2xl font-semibold tabular-nums mt-1 ${cls}`}>
          {value}
          {suffix && <span className="text-xs ml-1">{suffix}</span>}
        </p>
      </CardContent>
    </Card>
  );
}
