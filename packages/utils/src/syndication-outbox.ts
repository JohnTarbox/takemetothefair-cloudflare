// SYN1 — pure syndication helpers shared by the main app and the MCP Worker.
//
// This module is intentionally dependency-free (no Drizzle, no DB): it owns the
// *policy* that must stay identical across the five mutation write-paths —
// which fields are mirrored, whether a change is worth syndicating, and the
// exact shape of the snapshot payload. The Drizzle statement builders that
// embed these into a `db.batch()` live in `@takemetothefair/db-schema`
// (`syndication-helpers.ts`), because they need the schema + `sql`.
//
// Keeping the gate + snapshot shape here means a 6th future write-path can't
// drift: it imports the same allow-lists and the same snapshot builder.

export type SyndicationEntityType = "venue" | "event" | "event_day";

/**
 * Event fields whose change is worth mirroring to consumers. Matches the SYN2
 * batch-read projection. A change to a non-mirrored field (description, ticket
 * URL, focal point, …) does NOT write an outbox row or bump a version.
 */
export const MIRRORED_EVENT_FIELDS = ["name", "startDate", "endDate"] as const;

/**
 * Venue fields whose change must fan out to every event at that venue. Matches
 * the venue block of the SYN2 batch-read projection.
 */
export const MIRRORED_VENUE_FIELDS = ["name", "address", "city", "state", "zip"] as const;

/**
 * Event_day fields whose change alters the parent event's PUBLIC date range
 * (the inputs to `computePublicDates`). An image-only / notes-only day edit is
 * NOT mirror-relevant — the event's mirrored `startDate`/`endDate` don't move.
 */
export const MIRRORED_EVENT_DAY_FIELDS = ["date", "vendorOnly"] as const;

const MIRRORED_EVENT_SET: ReadonlySet<string> = new Set(MIRRORED_EVENT_FIELDS);
const MIRRORED_VENUE_SET: ReadonlySet<string> = new Set(MIRRORED_VENUE_FIELDS);
const MIRRORED_EVENT_DAY_SET: ReadonlySet<string> = new Set(MIRRORED_EVENT_DAY_FIELDS);

function mirroredSetFor(entityType: SyndicationEntityType): ReadonlySet<string> {
  if (entityType === "venue") return MIRRORED_VENUE_SET;
  if (entityType === "event_day") return MIRRORED_EVENT_DAY_SET;
  return MIRRORED_EVENT_SET;
}

/**
 * The gate: does this set of changed field names warrant a syndication event?
 *
 * - `event` / `venue`: true iff at least one changed field is mirrored.
 * - `event_day`: always true — day edits alter the parent event's public dates,
 *   which are mirrored. (The caller decides the day actually changed.)
 *
 * Field names are compared in the camelCase form the mutation layers use
 * (`startDate`, not `start_date`).
 */
export function mirroredFieldsChanged(
  entityType: SyndicationEntityType,
  changedFields: readonly string[]
): boolean {
  const allow = mirroredSetFor(entityType);
  return changedFields.some((f) => allow.has(f));
}

/** Narrow `changedFields` to just the mirrored ones (for the outbox row). */
export function mirroredFieldsOnly(
  entityType: SyndicationEntityType,
  changedFields: readonly string[]
): string[] {
  const allow = mirroredSetFor(entityType);
  return changedFields.filter((f) => allow.has(f));
}

export interface MirroredVenue {
  name: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
}

export interface MirroredEventSnapshot {
  name: string;
  slug: string | null;
  startDate: string | null; // ISO 8601 (UTC), null when unset
  endDate: string | null;
  venue: MirroredVenue | null;
}

/** Accepts a Date, epoch-ms number, ISO string, or null/undefined. */
function toIso(value: Date | number | string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (typeof value === "number") return new Date(value).toISOString();
  // Already a string — normalize through Date when parseable, else pass through.
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? value : d.toISOString();
}

type EventSnapshotInput = {
  name: string;
  slug?: string | null;
  startDate?: Date | number | string | null;
  endDate?: Date | number | string | null;
};

/**
 * Build the mirrored event payload stored in the outbox `snapshot` column and
 * returned by SYN2 batch-read. Single source of truth for the field set so the
 * push payload and the pull response never diverge.
 */
export function buildEventSnapshot(
  event: EventSnapshotInput,
  venue: MirroredVenue | null | undefined
): MirroredEventSnapshot {
  return {
    name: event.name,
    slug: event.slug ?? null,
    startDate: toIso(event.startDate),
    endDate: toIso(event.endDate),
    venue: venue
      ? {
          name: venue.name ?? null,
          address: venue.address ?? null,
          city: venue.city ?? null,
          state: venue.state ?? null,
          zip: venue.zip ?? null,
        }
      : null,
  };
}

/** Build the mirrored venue payload (used for `entity_type='venue'` outbox rows). */
export function buildVenueSnapshot(venue: MirroredVenue): MirroredVenue {
  return {
    name: venue.name ?? null,
    address: venue.address ?? null,
    city: venue.city ?? null,
    state: venue.state ?? null,
    zip: venue.zip ?? null,
  };
}
