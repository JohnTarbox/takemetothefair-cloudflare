/**
 * OPE-408 — geocode ONE venue. The single implementation, shared by the batch
 * sweep and by every venue-creation path.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 * OPE-207 shipped `venues_geocode` "for OPE-206 batch backfill AND every future
 * new venue". Only the backfill half was ever wired. Five follow-ups (OPE-213
 * name fallback, 214 paging, 215 force gate, 219 non-point refusal, 228 write
 * crashes) all hardened the manual tool; none connected it to creation. So
 * coordinates appeared only when a human remembered, and the missing-coords
 * rate climbed 0% (Jan–Apr) → 52% (Aug).
 *
 * That curve is not decaying data quality — it is **time since the last manual
 * sweep**. Old cohorts look perfect because somebody swept them.
 *
 * The cost was silent: a photo of the Summer Craft Fair at Maine Coast Mall,
 * with good GPS, taken during the show, could not be matched — because the
 * venue's lat/lng were NULL and the matcher had nothing to compare against.
 * Geocoding by hand from the stored address put the pin 0.073 mi away and the
 * same photo matched on the next attempt.
 *
 * ── Why extracted rather than reimplemented at each call site ───────────────
 * The decision logic here is a confidence gate that governs what may be written
 * to a public record, and it has been corrected five times. A second copy would
 * drift from the first, and the failure mode of a drifted confidence gate is a
 * wrong pin on a real venue — exactly what OPE-219 had to revert four of.
 *
 * The batch route now calls this too, so there is one gate, not two.
 */
import { and, eq, ne } from "drizzle-orm";
import { venues, adminActions, entityDataCitations } from "@/lib/db/schema";
import { buildEntityCitations, toCitationFields } from "@takemetothefair/utils";
import { recordMutation } from "@/lib/audit/record-mutation";
import { geocodeAddressDetailed, lookupPlace } from "@/lib/google-maps";
import {
  preflight,
  judge,
  judgeNameLookup,
  hasSufficientAddress,
  shouldWrite,
  forcedOutcome,
  duplicateOutcome,
  type VenueForGeocode,
  type GeocodeOutcome,
  type GeocodePin,
} from "@/lib/venues/geocode-decision";

/** Minimal db surface, so this is callable from any route without a cycle. */
type GeocodeDb = {
  select: (...args: never[]) => never;
  update: (...args: never[]) => never;
  insert: (...args: never[]) => never;
} & Record<string, unknown>;

/**
 * Resolve and (when the gate allows) store a pin for one venue.
 *
 * Returns the outcome rather than throwing: a venue that cannot be geocoded is
 * an ordinary result, not an error, and the caller decides whether to care.
 * The only throws that escape are genuine faults (network, D1), which the batch
 * route catches per-row so one bad venue cannot tank a sweep.
 */
export async function geocodeVenueRow(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  v: VenueForGeocode,
  apiKey: string,
  force: boolean
): Promise<GeocodeOutcome> {
  // Cheap outcomes first — already geocoded, no usable inputs, not a point.
  // No Google call for any of these.
  const pre = preflight(v, force);
  if (pre) return pre;

  // Which API can answer is a property of the ROW, not a caller choice: a
  // street address goes to the Geocoding API, a bare name+city+state to a
  // Places text search (OPE-213). preflight() guaranteed one path is viable.
  let outcome: GeocodeOutcome;
  let pin: GeocodePin | null = null;

  if (hasSufficientAddress(v)) {
    const detail = await geocodeAddressDetailed(
      v.address ?? "",
      v.city ?? "",
      v.state ?? "",
      v.zip ?? undefined,
      apiKey
    );
    outcome = judge(v, detail);
    if (detail) {
      pin = {
        lat: detail.lat,
        lng: detail.lng,
        placeId: detail.placeId,
        zip: detail.zip,
        address: null, // this path already had an address
      };
    }
  } else {
    const place = await lookupPlace(v.name, v.city ?? "", v.state ?? "", apiKey);
    outcome = judgeNameLookup(v, place);
    if (place && place.lat != null && place.lng != null) {
      pin = {
        lat: place.lat,
        lng: place.lng,
        placeId: place.googlePlaceId,
        zip: place.zip,
        // The text search returns the street address we were missing — this
        // fixes the root data gap, not just the coordinates.
        address: place.address,
      };
    }
  }

  // OPE-228 — `google_place_id` is UNIQUE, so writing a Place another venue
  // already owns would throw a raw D1 traceback. Surfacing it as
  // `duplicate-with` turns every collision into a merge_venue candidate.
  if (shouldWrite(outcome, force) && pin?.placeId) {
    const [owner] = await db
      .select({ id: venues.id, name: venues.name, slug: venues.slug })
      .from(venues)
      .where(and(eq(venues.googlePlaceId, pin.placeId), ne(venues.id, v.id)))
      .limit(1);
    if (owner) {
      return duplicateOutcome(outcome, {
        venue_id: owner.id,
        name: owner.name,
        slug: owner.slug,
      });
    }
  }

  if (shouldWrite(outcome, force) && pin) {
    if (outcome.status === "low-confidence") outcome = forcedOutcome(outcome, pin);

    const updates: Record<string, unknown> = {
      latitude: pin.lat,
      longitude: pin.lng,
      updatedAt: new Date(),
    };
    // A null placeId would build a "place_id:null" URL — skip both.
    if (pin.placeId) {
      updates.googlePlaceId = pin.placeId;
      updates.googleMapsUrl = `https://www.google.com/maps/place/?q=place_id:${pin.placeId}`;
    }
    // Fill blanks from the geocode, but never overwrite what is stored.
    if (!v.zip && pin.zip) updates.zip = pin.zip;
    if (!v.address?.trim() && pin.address) updates.address = pin.address;
    await db.update(venues).set(updates).where(eq(venues.id, v.id));

    // OPE-433 scope 5 — THE specimen. Venue 5e6f81ed was mutated in production
    // at 04:00:20Z on 2026-08-17 (city normalised, address filled, lat/long
    // set) and an agent, this sweep, and the mafa.org importer were
    // indistinguishable from the evidence. This is the row that would have
    // answered it.
    //
    // Scope 4's citation beside it says WHERE the values came from; this says
    // WHO wrote them. Both were missing, and only together do they make the
    // write reconstructable.
    await recordMutation(db, {
      entityType: "venue",
      entityId: v.id,
      verb: "update",
      actor: "venues_geocode",
      before: { latitude: v.latitude, longitude: v.longitude, zip: v.zip, address: v.address },
      after: updates,
      note: `geocode:${outcome.status}`,
    });

    // OPE-433 scope 4 — attribute what Google told us.
    //
    // This is the exact write the ticket's live specimen describes: a Martha's
    // Vineyard venue mutated in production at 04:00:20Z with city normalised,
    // address filled and lat/long set, and NOTHING recording what did it — so a
    // geocode sweep, an agent, and the mafa.org importer were indistinguishable
    // from the evidence.
    //
    // The values are attributable, so they get attributed. Best-effort: a
    // provenance row must never be able to fail a geocode that already
    // succeeded, and the pin is more valuable than the note about it.
    try {
      const cited = buildEntityCitations(
        "VENUE",
        v.id,
        toCitationFields({
          latitude: pin.lat,
          longitude: pin.lng,
          ...(updates.zip !== undefined ? { zip: updates.zip } : {}),
          ...(updates.address !== undefined ? { address: updates.address } : {}),
        }),
        {
          // The Place id is the stable identity of what Google matched; the
          // generic API endpoint would attribute every venue on earth to one
          // URL and make the column useless for telling two pins apart.
          sourceUrl: pin.placeId
            ? `https://www.google.com/maps/place/?q=place_id:${pin.placeId}`
            : "https://maps.googleapis.com/maps/api/geocode/json",
          sourceName: "Google Maps Geocoding",
          sourceType: "other",
          // `outcome.status` is the confidence gate's own verdict, so the
          // citation carries the same judgement the write was made under
          // rather than a number invented here.
          confidence: outcome.status === "ok" ? 0.9 : 0.6,
          notes: `geocode:${outcome.status}${outcome.method ? `:${outcome.method}` : ""}`,
          createdBy: "venues_geocode",
        },
        new Date()
      );
      if (cited.length > 0) await db.insert(entityDataCitations).values(cited);
    } catch {
      // Provenance is additive. The coordinates are already stored.
    }

    // A pin that beat the confidence gate by override must stay answerable
    // once the response is gone — OPE-203 attributes photos on it for as long
    // as it sits in the row.
    if (outcome.status === "forced") {
      await db.insert(adminActions).values({
        action: "venue.geocode.forced",
        actorUserId: null,
        targetType: "venue",
        targetId: v.id,
        payloadJson: JSON.stringify({
          reason: outcome.error,
          candidate: outcome.candidate,
          method: outcome.method,
          lat: pin.lat,
          lng: pin.lng,
        }),
        createdAt: new Date(),
      });
    }
  }

  return outcome;
}

/**
 * Geocode a freshly-created venue. Fire-and-forget: NEVER throws, never blocks.
 *
 * Creating a venue must not fail because Google is slow, rate-limited or down.
 * A missed pin is recoverable by the nightly sweep; a failed venue insert loses
 * a submission. So every fault here is swallowed and left for the sweep.
 *
 * `force` is hard-coded false. Inline creation must never store a
 * low-confidence pin: OPE-219 exists because forcing produced four wrong pins
 * that had to be reverted, and the caller here is an automated ingest with no
 * human looking at the candidate. Low-confidence rows stay NULL and surface in
 * the missing-coords count for the analyst lane.
 */
export async function geocodeNewVenue(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  db: any,
  venueId: string,
  apiKey: string | undefined
): Promise<GeocodeOutcome | null> {
  if (!apiKey) return null; // unconfigured env (dev/test) — sweep will catch up
  try {
    const [row] = await db
      .select({
        id: venues.id,
        name: venues.name,
        address: venues.address,
        city: venues.city,
        state: venues.state,
        zip: venues.zip,
        latitude: venues.latitude,
        longitude: venues.longitude,
      })
      .from(venues)
      .where(eq(venues.id, venueId))
      .limit(1);
    if (!row) return null;
    return await geocodeVenueRow(db, row as VenueForGeocode, apiKey, false);
  } catch {
    // Deliberately silent: see the docblock. The nightly sweep is the retry.
    return null;
  }
}

export type { GeocodeDb };
