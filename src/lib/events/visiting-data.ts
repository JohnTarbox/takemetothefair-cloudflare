import { and, desc, eq, inArray } from "drizzle-orm";
import type { Database } from "@/lib/db";
import { eventDataCitations, events, venues } from "@/lib/db/schema";

/** The cited fields the Visiting box shows a "recorded {date}" for. */
const CITED_FIELDS = ["pet_friendly", "parking_notes", "accessibility_notes"] as const;

/**
 * OPE-1479 — the stored facts the "Visiting" box reads that the shared event
 * projection does not carry. ⚠️ Read them from here, never from `event.venue`:
 * the page casts the lite venue projection to the full row type, so
 * `event.venue.parking` type-checks and is `undefined` at runtime. The
 * organizer's own notes (OPE-1481) are read here for the same reason.
 */
export async function getVisitingFacts(
  db: Database,
  eventId: string,
  venueId: string | null | undefined
): Promise<{
  venueAccessibility: string | null;
  venueParking: string | null;
  venuePetFriendly: string | null;
  petCitedOn: Date | null;
  parkingNotes: string | null;
  parkingCitedOn: Date | null;
  accessibilityNotes: string | null;
  accessibilityCitedOn: Date | null;
}> {
  const [venueRow, eventRow, citations] = await Promise.all([
    venueId
      ? db
          .select({
            accessibility: venues.accessibility,
            parking: venues.parking,
            petFriendly: venues.petFriendly,
          })
          .from(venues)
          .where(eq(venues.id, venueId))
          .limit(1)
          .then((r) => r[0] ?? null)
      : Promise.resolve(null),
    db
      .select({
        parkingNotes: events.parkingNotes,
        accessibilityNotes: events.accessibilityNotes,
      })
      .from(events)
      .where(eq(events.id, eventId))
      .limit(1)
      .then((r) => r[0] ?? null),
    db
      .select({ fieldName: eventDataCitations.fieldName, createdAt: eventDataCitations.createdAt })
      .from(eventDataCitations)
      .where(
        and(
          eq(eventDataCitations.eventId, eventId),
          inArray(eventDataCitations.fieldName, [...CITED_FIELDS]),
          eq(eventDataCitations.state, "active")
        )
      )
      .orderBy(desc(eventDataCitations.createdAt)),
  ]);
  // Newest active citation per field (rows arrive newest-first).
  const citedOn = (field: (typeof CITED_FIELDS)[number]): Date | null =>
    citations.find((c) => c.fieldName === field)?.createdAt ?? null;
  return {
    venueAccessibility: venueRow?.accessibility ?? null,
    venueParking: venueRow?.parking ?? null,
    venuePetFriendly: venueRow?.petFriendly ?? null,
    petCitedOn: citedOn("pet_friendly"),
    parkingNotes: eventRow?.parkingNotes ?? null,
    parkingCitedOn: citedOn("parking_notes"),
    accessibilityNotes: eventRow?.accessibilityNotes ?? null,
    accessibilityCitedOn: citedOn("accessibility_notes"),
  };
}
