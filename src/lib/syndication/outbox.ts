// SYN1 — main-app side: build the syndication-outbox statements to splice into
// a mutation's `db.batch([...])`. Returns `[]` when the change isn't mirrored,
// so call sites can unconditionally spread the result:
//
//   const batch = [
//     db.update(events).set(updateData).where(eq(events.id, id)),
//     ...eventSyndicationStatements(db, { eventId: id, changedFields, event, venue }),
//   ];
//
// The gate + snapshot policy lives in @takemetothefair/utils; the Drizzle value
// builders in @takemetothefair/db-schema. This thin wrapper exists per-artifact
// because the main app and the MCP Worker can't share server code — but both
// import the same pure policy, so the five write-paths stay in lock-step.
import { eq } from "drizzle-orm";
import {
  syndicationOutbox,
  events,
  buildSyndicationOutboxValues,
  eventSyndicationVersionBumpExpr,
} from "@/lib/db/schema";
import {
  mirroredFieldsChanged,
  mirroredFieldsOnly,
  buildEventSnapshot,
  buildVenueSnapshot,
  type MirroredVenue,
} from "@takemetothefair/utils";
import type { getCloudflareDb } from "@/lib/cloudflare";

type Db = ReturnType<typeof getCloudflareDb>;
// Drizzle's batch tuple is strongly typed; the call sites already cast the
// whole array, so an opaque statement element keeps this helper decoupled.
type Stmt = unknown;

type EventMirror = {
  name: string;
  slug?: string | null;
  startDate?: Date | number | string | null;
  endDate?: Date | number | string | null;
};

/**
 * Outbox row + per-event version bump for an `event` mutation. `event` is the
 * post-update mirrored payload (merge prior row with the incoming changes);
 * `venue` is the event's venue mirrored fields (or null).
 */
export function eventSyndicationStatements(
  db: Db,
  args: {
    eventId: string;
    changedFields: readonly string[];
    event: EventMirror;
    venue: MirroredVenue | null;
  }
): Stmt[] {
  if (!mirroredFieldsChanged("event", args.changedFields)) return [];
  const snapshot = buildEventSnapshot(args.event, args.venue);
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

/**
 * Outbox row + fan-out version bump for a `venue` mutation. Bumps
 * `syndication_version` on every event at the venue in a single UPDATE (no
 * per-event statements → no D1 bound-param blow-up).
 */
export function venueSyndicationStatements(
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
