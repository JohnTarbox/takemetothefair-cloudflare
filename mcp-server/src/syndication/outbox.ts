// SYN1 — MCP-Worker side: build the syndication-outbox statements to splice
// into an update tool's `db.batch([...])`. Mirror of the main-app helper
// (`src/lib/syndication/outbox.ts`); the two can't share server code, but both
// import the same pure policy from @takemetothefair/utils so the five
// write-paths stay in lock-step. Returns `[]` when the change isn't mirrored.
import { eq } from "drizzle-orm";
import {
  syndicationOutbox,
  events,
  venues,
  buildSyndicationOutboxValues,
  eventSyndicationVersionBumpExpr,
} from "../schema.js";
import {
  mirroredFieldsChanged,
  mirroredFieldsOnly,
  buildEventSnapshot,
  buildVenueSnapshot,
  type MirroredVenue,
  type SyndicationChangeMessage,
} from "@takemetothefair/utils";
import type { Db } from "../db.js";

type Stmt = unknown;

/**
 * Enqueue a syndication trigger from an MCP tool, after its batch commits.
 * Best-effort + never throws — the durable outbox row is the source of truth,
 * so a dropped enqueue only delays delivery. A syndication failure must never
 * fail the underlying correction.
 */
export async function enqueueSyndicationChange(
  env: { SYNDICATION_CHANGES?: { send: (m: unknown) => Promise<unknown> } } | undefined,
  message: SyndicationChangeMessage
): Promise<void> {
  try {
    await env?.SYNDICATION_CHANGES?.send(message);
  } catch {
    // Swallow — never propagate into the tool's success path.
  }
}

async function venueMirrorFor(db: Db, venueId: string | null): Promise<MirroredVenue | null> {
  if (!venueId) return null;
  const [v] = await db
    .select({
      name: venues.name,
      address: venues.address,
      city: venues.city,
      state: venues.state,
      zip: venues.zip,
    })
    .from(venues)
    .where(eq(venues.id, venueId))
    .limit(1);
  return v ?? null;
}

/** Outbox row + per-event version bump for `update_event`. */
export async function eventOutboxStatements(
  db: Db,
  args: {
    eventId: string;
    changedFields: readonly string[];
    event: { name: string; slug?: string | null; startDate?: unknown; endDate?: unknown };
    venueId: string | null;
  }
): Promise<Stmt[]> {
  if (!mirroredFieldsChanged("event", args.changedFields)) return [];
  const venue = await venueMirrorFor(db, args.venueId);
  const snapshot = buildEventSnapshot(
    {
      name: args.event.name,
      slug: args.event.slug,
      startDate: args.event.startDate as Date | null,
      endDate: args.event.endDate as Date | null,
    },
    venue
  );
  return [
    db.insert(syndicationOutbox).values(
      buildSyndicationOutboxValues({
        entityType: "event",
        entityId: args.eventId,
        changedFields: mirroredFieldsOnly("event", args.changedFields),
        snapshot,
      })
    ),
    db
      .update(events)
      .set({ syndicationVersion: eventSyndicationVersionBumpExpr() })
      .where(eq(events.id, args.eventId)),
  ];
}

/** Outbox row + fan-out version bump for `update_venue`. */
export function venueOutboxStatements(
  db: Db,
  args: { venueId: string; changedFields: readonly string[]; venue: MirroredVenue }
): Stmt[] {
  if (!mirroredFieldsChanged("venue", args.changedFields)) return [];
  const snapshot = buildVenueSnapshot(args.venue);
  return [
    db.insert(syndicationOutbox).values(
      buildSyndicationOutboxValues({
        entityType: "venue",
        entityId: args.venueId,
        changedFields: mirroredFieldsOnly("venue", args.changedFields),
        snapshot,
      })
    ),
    db
      .update(events)
      .set({ syndicationVersion: eventSyndicationVersionBumpExpr() })
      .where(eq(events.venueId, args.venueId)),
  ];
}

/**
 * Outbox row + parent-event version bump for `update_event_day`. The outbox row
 * is keyed by the day id (its own change_version stream); the version bump and
 * delivery resolve to the PARENT event. Snapshot is the parent event's mirrored
 * payload so deliveries stay self-contained + event-grained.
 */
export async function eventDayOutboxStatements(
  db: Db,
  args: {
    dayId: string;
    eventId: string;
    changedFields: readonly string[];
    event: { name: string; slug?: string | null; startDate?: unknown; endDate?: unknown };
    venueId: string | null;
  }
): Promise<Stmt[]> {
  if (!mirroredFieldsChanged("event_day", args.changedFields)) return [];
  const venue = await venueMirrorFor(db, args.venueId);
  const snapshot = buildEventSnapshot(
    {
      name: args.event.name,
      slug: args.event.slug,
      startDate: args.event.startDate as Date | null,
      endDate: args.event.endDate as Date | null,
    },
    venue
  );
  return [
    db.insert(syndicationOutbox).values(
      buildSyndicationOutboxValues({
        entityType: "event_day",
        entityId: args.dayId,
        changedFields: mirroredFieldsOnly("event_day", args.changedFields),
        snapshot,
      })
    ),
    db
      .update(events)
      .set({ syndicationVersion: eventSyndicationVersionBumpExpr() })
      .where(eq(events.id, args.eventId)),
  ];
}
