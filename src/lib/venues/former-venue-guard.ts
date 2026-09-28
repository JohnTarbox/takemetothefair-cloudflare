/**
 * OPE-1180 — the main app's side of the FORMER-venue date guard.
 *
 * Loads the venue and runs `checkFormerVenue` (`@takemetothefair/utils`, shared
 * with the MCP Worker). Two ways a caller applies the verdict:
 *
 *   - EXPLICIT choice (an admin or promoter picked this venue): a `refuse` is a
 *     409 with the message; a `flag` sets `flagged_for_review`.
 *   - INGEST (an importer or matcher picked it): never fail the submission —
 *     a `refuse` leaves the venue EMPTY and flags the row for review, and a
 *     `flag` keeps the venue and flags. `resolveIngestVenue` does that.
 *
 * The database triggers in drizzle/0333 make the refuse outcome true on every
 * write path; this is what turns it into a readable answer on the named ones.
 */
import { eq } from "drizzle-orm";
import { checkFormerVenue, type FormerVenueVerdict } from "@takemetothefair/utils";
import { venues } from "@/lib/db/schema";
import type { Database } from "@/lib/db";

type Db = Database;

export async function checkEventVenue(
  db: Db,
  venueId: string | null | undefined,
  eventEnd: Date | null | undefined
): Promise<FormerVenueVerdict> {
  if (!venueId) return { kind: "allow" };
  const [v] = await db
    .select({
      id: venues.id,
      name: venues.name,
      status: venues.status,
      useEndedEdtf: venues.useEndedEdtf,
      useEndedEarliest: venues.useEndedEarliest,
      useEndedLatest: venues.useEndedLatest,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return checkFormerVenue(v ?? null, eventEnd ?? null);
}

/** Ingest application: never fails; post-closure → no venue + review flag. */
export async function resolveIngestVenue(
  db: Db,
  venueId: string | null | undefined,
  eventEnd: Date | null | undefined
): Promise<{ venueId: string | null; flagForReview: boolean; note: string | null }> {
  const verdict = await checkEventVenue(db, venueId, eventEnd);
  if (verdict.kind === "refuse")
    return { venueId: null, flagForReview: true, note: verdict.message };
  if (verdict.kind === "flag")
    return { venueId: venueId ?? null, flagForReview: true, note: verdict.reason };
  return { venueId: venueId ?? null, flagForReview: false, note: null };
}
