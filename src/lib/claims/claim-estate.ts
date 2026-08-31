/**
 * OPE-236 §5 — the numbers that stop `/admin/claims` reading as "nothing to do".
 *
 * The page renders the PENDING/DISPUTED review queue, which is nearly always
 * short. That is honest about the queue and misleading about the estate: 73
 * listings carry `claimed=1`, 26 of those claimants have never verified an email
 * address, and none of that was visible anywhere on the page.
 *
 * `divergent` is the one to watch. It counts listings that are claimed but carry
 * no `entity_claims` row — the OPE-236 defect itself, expressed as a number.
 * A heartbeat probe would be the wrong instrument for it: claims arrive a few
 * times a year, so a silence-window probe would fire RED on any quiet week
 * (exactly the false-RED the probe registry warns against). A divergence count
 * is silent at zero traffic and non-zero only when the defect actually recurs.
 *
 * ⚠️ `divergent` is EXPECTED to be large the day this ships, and that is not a
 * regression: ~70 of the claimed rows are self-authored listings (registrant
 * created the listing at signup) which deliberately do NOT get a claim row —
 * authoring is not claiming, which is why the OPE-236 §3 backfill was withdrawn.
 * The signal is the TREND on rows claimed after the fix, so the recent-window
 * count is reported separately and is the one that should stay at zero.
 */
import { and, eq, gte, isNull, sql } from "drizzle-orm";
import { entityClaims, promoters, users, vendors } from "@/lib/db/schema";
import type { Db } from "@/lib/analytics-overview/shared";

/** Rows claimed in this window are the ones the §4 fix is responsible for. */
export const DIVERGENCE_WINDOW_DAYS = 30;

export interface ClaimEstate {
  /** Listings (vendor + promoter) carrying `claimed = 1`. */
  ownerOccupied: number;
  /** Of those, claimants whose account has never verified an email address. */
  unverifiedClaimants: number;
  /** Claimed vendor listings with no `entity_claims` row at all — all time. */
  divergent: number;
  /** The same, restricted to the last DIVERGENCE_WINDOW_DAYS. Should be 0. */
  divergentRecent: number;
}

async function countRows(db: Db, q: Promise<{ n: number }[]>): Promise<number> {
  const [r] = await q;
  return Number(r?.n ?? 0);
}

export async function getClaimEstate(db: Db): Promise<ClaimEstate> {
  // `claimed_at` is a unix-epoch INTEGER. Comparing it against
  // datetime('now', ...) silently matches nothing and returns a confident 0 —
  // so the cutoff is computed in JS and passed as a Date the column's own
  // timestamp mode encodes.
  const cutoff = new Date(Date.now() - DIVERGENCE_WINDOW_DAYS * 86_400_000);

  const claimedVendors = eq(vendors.claimed, true);

  // A claimed listing with no row of ANY status for this entity. Deliberately
  // not scoped to the claimant: a row under a different user still means the
  // claim is visible to review, which is what this number is asking about.
  const hasNoClaimRow = sql`NOT EXISTS (
    SELECT 1 FROM ${entityClaims}
    WHERE ${entityClaims.entityType} = 'VENDOR'
      AND ${entityClaims.entityId} = ${vendors.id}
  )`;

  const [vendorsClaimed, promotersClaimed, unverified, divergent, divergentRecent] =
    await Promise.all([
      countRows(
        db,
        db
          .select({ n: sql<number>`count(*)` })
          .from(vendors)
          .where(claimedVendors)
      ),
      countRows(
        db,
        db
          .select({ n: sql<number>`count(*)` })
          .from(promoters)
          .where(eq(promoters.claimed, true))
      ),
      countRows(
        db,
        db
          .select({ n: sql<number>`count(distinct ${users.id})` })
          .from(users)
          .innerJoin(vendors, eq(vendors.claimedBy, users.id))
          .where(and(claimedVendors, isNull(users.emailVerified)))
      ),
      countRows(
        db,
        db
          .select({ n: sql<number>`count(*)` })
          .from(vendors)
          .where(and(claimedVendors, hasNoClaimRow))
      ),
      countRows(
        db,
        db
          .select({ n: sql<number>`count(*)` })
          .from(vendors)
          .where(and(claimedVendors, hasNoClaimRow, gte(vendors.claimedAt, cutoff)))
      ),
    ]);

  return {
    ownerOccupied: vendorsClaimed + promotersClaimed,
    unverifiedClaimants: unverified,
    divergent,
    divergentRecent,
  };
}
