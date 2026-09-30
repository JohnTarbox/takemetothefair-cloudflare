/**
 * OPE-979 — a promoter can stop trading, and another can take its shows over.
 *
 * Three pieces, one file:
 *   - the status vocabulary and the check a writer must pass to record it;
 *   - `isCeasedPromoter`, the one predicate every reader (enrichment, rollover)
 *     uses, so "which statuses mean stop" is decided once;
 *   - `computePromoterBlastRadius`, the "this promoter is gone — what does it
 *     still own?" read that had to be assembled by hand for Eagle Shows.
 */
import { and, eq, isNull, or, sql } from "drizzle-orm";
import { eventSeries, events, promoters } from "../schema.js";
import { PUBLIC_EVENT_STATUSES } from "../helpers.js";
import type { Db } from "../db.js";

export const PROMOTER_OPERATING_STATUSES = ["ACTIVE", "CEASED", "MERGED", "UNKNOWN"] as const;
export type PromoterOperatingStatus = (typeof PROMOTER_OPERATING_STATUSES)[number];

/**
 * A promoter that is no longer trading on its own account. MERGED counts: its
 * shows are someone else's now, so re-enriching its old site or rolling its
 * events forward under its name is the same mistake.
 */
export function isCeasedPromoter(status: string | null | undefined): boolean {
  return status === "CEASED" || status === "MERGED";
}

/**
 * Returns an error message, or null when the patch is acceptable.
 *
 * `updates` is the column-keyed patch update_promoter is about to write, so the
 * check sees the row as it WILL be (a status set in an earlier call plus a
 * successor set now is judged together).
 */
export async function validatePromoterSuccession(
  db: Db,
  current: {
    id: string;
    operatingStatus?: string | null;
    operatingStatusSourceUrl?: string | null;
  },
  updates: Record<string, unknown>
): Promise<string | null> {
  const final = <T>(column: string, existing: T): T =>
    (column in updates ? updates[column] : existing) as T;

  const status = final("operatingStatus", current.operatingStatus ?? null);
  const sourceUrl = final("operatingStatusSourceUrl", current.operatingStatusSourceUrl ?? null);
  if ("operatingStatus" in updates && isCeasedPromoter(status) && !sourceUrl) {
    return `operating_status ${status} needs operating_status_source_url — the page that shows it. A closure recorded from memory is the prose-in-description problem again.`;
  }

  const successor = updates.succeededByPromoterId;
  if (typeof successor === "string") {
    if (successor === current.id) {
      return "succeeded_by_promoter_id cannot be the promoter itself.";
    }
    const [row] = await db
      .select({ id: promoters.id })
      .from(promoters)
      .where(eq(promoters.id, successor))
      .limit(1);
    if (!row) return `succeeded_by_promoter_id ${successor} is not a promoter.`;
    if (!isCeasedPromoter(status)) {
      return "succeeded_by_promoter_id is only meaningful when operating_status is CEASED or MERGED — set both.";
    }
  }
  return null;
}

/** Lowercased host without a leading www., matching events.source_domain's shape. */
export function websiteHost(website: string | null | undefined): string | null {
  if (!website?.trim()) return null;
  const raw = website.trim();
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return u.hostname.toLowerCase().replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export type BlastRadiusKey = "promoter_id" | "series" | "source_domain";

export interface BlastRadiusEvent {
  id: string;
  name: string;
  slug: string;
  startDate: Date | null;
  endDate: Date | null;
  status: string;
  lifecycleStatus: string | null;
  /** status is APPROVED or TENTATIVE — the row renders on the public site. */
  listedPublicly: boolean;
  promoterId: string | null;
  seriesId: string | null;
  sourceDomain: string | null;
  /** Every key that reached this row. A row reached ONLY by source_domain is the
   *  case the ticket names: nothing else pointed at it. */
  matchedBy: BlastRadiusKey[];
}

export interface BlastRadius {
  promoter: {
    id: string;
    companyName: string;
    website: string | null;
    operatingStatus: string | null;
    succeededByPromoterId: string | null;
  };
  websiteHost: string | null;
  series: Array<{ id: string; name: string; canonicalSlug: string }>;
  futureEvents: BlastRadiusEvent[];
  summary: {
    futureEvents: number;
    listedPublicly: number;
    series: number;
    reachableOnlyBySourceDomain: number;
  };
}

/**
 * Everything a promoter still owns from `now` on. "Future" means the event has
 * not finished: COALESCE(end_date, start_date) >= now. Merge tombstones are
 * excluded (they redirect); every other status is returned with `listedPublicly`
 * so a REJECTED or CANCELLED row is visible as such rather than silently absent.
 */
export async function computePromoterBlastRadius(
  db: Db,
  promoterId: string,
  now: Date
): Promise<BlastRadius | null> {
  const [promoter] = await db
    .select({
      id: promoters.id,
      companyName: promoters.companyName,
      website: promoters.website,
      operatingStatus: promoters.operatingStatus,
      succeededByPromoterId: promoters.succeededByPromoterId,
    })
    .from(promoters)
    .where(eq(promoters.id, promoterId))
    .limit(1);
  if (!promoter) return null;

  const host = websiteHost(promoter.website);
  const series = await db
    .select({
      id: eventSeries.id,
      name: eventSeries.name,
      canonicalSlug: eventSeries.canonicalSlug,
    })
    .from(eventSeries)
    .where(eq(eventSeries.promoterId, promoterId));
  // Subquery instead of an IN-list of ids: a large promoter's series count must
  // not become a bind-parameter count (D1 caps a statement at 100).
  const seriesOfPromoter = sql`(SELECT ${eventSeries.id} FROM ${eventSeries} WHERE ${eventSeries.promoterId} = ${promoterId})`;
  const keys = [
    eq(events.promoterId, promoterId),
    sql`${events.seriesId} IN ${seriesOfPromoter}`,
    ...(host ? [eq(events.sourceDomain, host)] : []),
  ];
  const nowSec = Math.floor(now.getTime() / 1000);
  const rows = await db
    .select({
      id: events.id,
      name: events.name,
      slug: events.slug,
      startDate: events.startDate,
      endDate: events.endDate,
      status: events.status,
      lifecycleStatus: events.lifecycleStatus,
      promoterId: events.promoterId,
      seriesId: events.seriesId,
      sourceDomain: events.sourceDomain,
    })
    .from(events)
    .where(
      and(
        isNull(events.mergedInto),
        or(...keys),
        sql`COALESCE(${events.endDate}, ${events.startDate}) >= ${nowSec}`
      )
    )
    .orderBy(events.startDate);

  const publicStatuses: readonly string[] = PUBLIC_EVENT_STATUSES;
  const seriesSet = new Set(series.map((s) => s.id));
  const futureEvents: BlastRadiusEvent[] = rows.map((r) => {
    const matchedBy: BlastRadiusKey[] = [];
    if (r.promoterId === promoterId) matchedBy.push("promoter_id");
    if (r.seriesId && seriesSet.has(r.seriesId)) matchedBy.push("series");
    if (host && r.sourceDomain === host) matchedBy.push("source_domain");
    return {
      ...r,
      slug: String(r.slug),
      listedPublicly: publicStatuses.includes(r.status),
      matchedBy,
    };
  });

  return {
    promoter,
    websiteHost: host,
    series,
    futureEvents,
    summary: {
      futureEvents: futureEvents.length,
      listedPublicly: futureEvents.filter((e) => e.listedPublicly).length,
      series: series.length,
      reachableOnlyBySourceDomain: futureEvents.filter(
        (e) => e.matchedBy.length === 1 && e.matchedBy[0] === "source_domain"
      ).length,
    },
  };
}
