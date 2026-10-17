import { and, desc, eq } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { eventDataCitations, venues } from "@/lib/db/schema";

/**
 * OPE-1479 — the stored facts the "Visiting" box reads that the shared event
 * projection does not carry. ⚠️ Read them from here, never from `event.venue`:
 * the page casts the lite venue projection to the full row type, so
 * `event.venue.parking` type-checks and is `undefined` at runtime.
 */
export async function getVisitingFacts(
  db: Database,
  eventId: string,
  venueId: string | null | undefined
): Promise<{
  venueAccessibility: string | null;
  venueParking: string | null;
  petCitedOn: Date | null;
}> {
  const [venueRow, citation] = await Promise.all([
    venueId
      ? db
          .select({ accessibility: venues.accessibility, parking: venues.parking })
          .from(venues)
          .where(eq(venues.id, venueId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select({ createdAt: eventDataCitations.createdAt })
      .from(eventDataCitations)
      .where(
        and(
          eq(eventDataCitations.eventId, eventId),
          eq(eventDataCitations.fieldName, "pet_friendly"),
          eq(eventDataCitations.state, "active")
        )
      )
      .orderBy(desc(eventDataCitations.createdAt))
      .limit(1)
      .then((r) => r[0] ?? null),
  ]);
  return {
    venueAccessibility: venueRow?.accessibility ?? null,
    venueParking: venueRow?.parking ?? null,
    petCitedOn: citation?.createdAt ?? null,
  };
}
