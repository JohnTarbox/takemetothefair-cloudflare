/**
 * OPE-391 Blocks D2 + E — first-party engagement and the email/relationship
 * facet, for the Site Health tab.
 *
 * ── Why first-party and not GA4 ───────────────────────────────────────────
 *
 * GA4 traffic is not engagement, and the two disagree on the same action: on
 * 2026-08-25 GA4 counted 3,151 blog outbound clicks against the site's own
 * 4,113. Same direction, same argument, different denominator — the beacon
 * fires before any consent/adblock layer can drop it. The headline uses the
 * first-party number; GA4 stays the traffic instrument in Block D1.
 *
 * ── The property keys are camelCase, and this cost a query ────────────────
 *
 * The ticket names the GA4 custom dimensions `target_type` / `source_slug`.
 * The first-party beacon stores `targetType` / `sourceSlug` / `targetSlug`,
 * and `searchTerm` / `resultsCount`. Reading the snake_case keys here returns
 * NULL for every one of the 4,270 rows — a panel that renders "no data" while
 * the data sits right there. Verified against prod before writing.
 */
import { and, desc, eq, gte, lt, sql } from "drizzle-orm";
import type { DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "@/lib/db/schema";
import { analyticsEvents, supportObligations } from "@/lib/db/schema";

type Db = DrizzleD1Database<typeof schema>;

export const ENGAGEMENT_WINDOW_DAYS = 30;

export interface NamedCount {
  name: string;
  count: number;
}

export interface EngagementReport {
  windowDays: number;
  /** `event_category` = "engagement" — attention, not intent. */
  engagement: NamedCount[];
  /** `event_category` = "conversion" — kept visually separate on purpose. */
  conversion: NamedCount[];
  /** Where blog outbound clicks actually go. */
  blogTargetMix: NamedCount[];
  blogClickTotal: number;
  /** Posts sending the most outbound clicks. */
  topSourcePosts: NamedCount[];
  /** Searches that returned nothing — each one is a content gap. */
  zeroResultSearches: NamedCount[];
}

export interface EmailFacet {
  /** All obligation rows, by status. */
  byStatus: NamedCount[];
  openCount: number;
  /** Age in days of the oldest OPEN obligation. Computed, never frozen. */
  oldestOpenDays: number | null;
  /**
   * Rows triaged as not-an-obligation or duplicate — cold outreach and
   * clutter. Surfaced separately so the open queue is not read as "23 people
   * waiting on us" when most of it was never a request.
   */
  triagedOutCount: number;
  /** newsletter_submit → newsletter_confirm, in the window. */
  newsletterSubmits: number;
  newsletterConfirms: number;
  newsletterConfirmRate: number | null;
  /** register_view → interacted → submitted. There is no confirm event. */
  registerViews: number;
  registerInteracted: number;
  registerSubmitted: number;
}

/** JSON extraction on a first-party property. camelCase — see the header. */
function prop(key: string) {
  return sql<string | null>`json_extract(${analyticsEvents.properties}, ${"$." + key})`;
}

async function topByProperty(
  db: Db,
  eventName: string,
  key: string,
  since: Date,
  limit: number
): Promise<NamedCount[]> {
  const rows = await db
    .select({ name: prop(key), count: sql<number>`COUNT(*)` })
    .from(analyticsEvents)
    .where(and(eq(analyticsEvents.eventName, eventName), gte(analyticsEvents.timestamp, since)))
    .groupBy(prop(key))
    .orderBy(desc(sql`COUNT(*)`))
    .limit(limit);
  return rows
    .filter((r) => r.name != null && r.name !== "")
    .map((r) => ({ name: String(r.name), count: Number(r.count) }));
}

export async function getEngagementReport(
  db: Db,
  opts: { windowDays?: number; now?: Date } = {}
): Promise<EngagementReport> {
  const windowDays = opts.windowDays ?? ENGAGEMENT_WINDOW_DAYS;
  const since = new Date((opts.now ?? new Date()).getTime() - windowDays * 86_400_000);

  const [byCategory, blogMix, topPosts, zeroResults, blogTotalRow] = await Promise.all([
    db
      .select({
        category: analyticsEvents.eventCategory,
        name: analyticsEvents.eventName,
        count: sql<number>`COUNT(*)`,
      })
      .from(analyticsEvents)
      .where(gte(analyticsEvents.timestamp, since))
      .groupBy(analyticsEvents.eventCategory, analyticsEvents.eventName)
      .orderBy(desc(sql`COUNT(*)`)),
    topByProperty(db, "blog_outbound_click", "targetType", since, 10),
    topByProperty(db, "blog_outbound_click", "sourceSlug", since, 8),
    db
      .select({ name: prop("searchTerm"), count: sql<number>`COUNT(*)` })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.eventName, "internal_search_performed"),
          gte(analyticsEvents.timestamp, since),
          sql`CAST(json_extract(${analyticsEvents.properties}, '$.resultsCount') AS INTEGER) = 0`
        )
      )
      .groupBy(prop("searchTerm"))
      .orderBy(desc(sql`COUNT(*)`))
      .limit(10),
    db
      .select({ n: sql<number>`COUNT(*)` })
      .from(analyticsEvents)
      .where(
        and(
          eq(analyticsEvents.eventName, "blog_outbound_click"),
          gte(analyticsEvents.timestamp, since)
        )
      ),
  ]);

  const pick = (category: string): NamedCount[] =>
    byCategory
      .filter((r) => r.category === category)
      .map((r) => ({ name: r.name, count: Number(r.count) }));

  return {
    windowDays,
    engagement: pick("engagement"),
    conversion: pick("conversion"),
    blogTargetMix: blogMix,
    blogClickTotal: Number(blogTotalRow[0]?.n ?? 0),
    topSourcePosts: topPosts,
    zeroResultSearches: zeroResults
      .filter((r) => r.name != null && r.name !== "")
      .map((r) => ({ name: String(r.name), count: Number(r.count) })),
  };
}

export async function getEmailFacet(
  db: Db,
  opts: { windowDays?: number; now?: Date } = {}
): Promise<EmailFacet> {
  const windowDays = opts.windowDays ?? ENGAGEMENT_WINDOW_DAYS;
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - windowDays * 86_400_000);

  const [statusRows, oldestOpenRow, funnelRows] = await Promise.all([
    db
      .select({ name: supportObligations.status, count: sql<number>`COUNT(*)` })
      .from(supportObligations)
      .groupBy(supportObligations.status),
    // Oldest OPEN only. The ticket's "oldest open is 47 days" figure was in
    // fact the oldest *triaged-out* row; computing it live avoids inheriting
    // that, and avoids freezing a number that moves every day.
    db
      .select({ openedAt: supportObligations.openedAt })
      .from(supportObligations)
      .where(eq(supportObligations.status, "open"))
      .orderBy(supportObligations.openedAt)
      .limit(1),
    db
      .select({ name: analyticsEvents.eventName, count: sql<number>`COUNT(*)` })
      .from(analyticsEvents)
      .where(
        and(
          gte(analyticsEvents.timestamp, since),
          lt(analyticsEvents.timestamp, now),
          sql`${analyticsEvents.eventName} IN ('newsletter_submit','newsletter_confirm','register_view','register_form_interacted','register_submitted')`
        )
      )
      .groupBy(analyticsEvents.eventName),
  ]);

  const byStatus = statusRows.map((r) => ({ name: r.name, count: Number(r.count) }));
  const at = (name: string) => Number(funnelRows.find((r) => r.name === name)?.count ?? 0);

  const openCount = byStatus.find((s) => s.name === "open")?.count ?? 0;
  const triagedOutCount = byStatus
    .filter((s) => s.name === "not_an_obligation" || s.name === "duplicate")
    .reduce((a, s) => a + s.count, 0);

  const oldestOpenedAt = oldestOpenRow[0]?.openedAt ?? null;
  const oldestOpenDays =
    oldestOpenedAt == null
      ? null
      : Math.max(0, Math.floor((now.getTime() - oldestOpenedAt.getTime()) / 86_400_000));

  const newsletterSubmits = at("newsletter_submit");
  const newsletterConfirms = at("newsletter_confirm");

  return {
    byStatus,
    openCount,
    oldestOpenDays,
    triagedOutCount,
    newsletterSubmits,
    newsletterConfirms,
    // NULL, not 0, when nobody signed up — a rate with an empty denominator is
    // not "0% confirmed".
    newsletterConfirmRate: newsletterSubmits === 0 ? null : newsletterConfirms / newsletterSubmits,
    registerViews: at("register_view"),
    registerInteracted: at("register_form_interacted"),
    registerSubmitted: at("register_submitted"),
  };
}
