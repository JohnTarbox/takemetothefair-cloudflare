#!/usr/bin/env tsx
/**
 * Deploy-time JSON-LD required-field validator (A10, 2026-06-26).
 *
 * Exercises the pure structured-data builders with KNOWN-GOOD inputs and
 * asserts the required schema.org fields are PRESENT AND POPULATED. Guards
 * against the K46 class of regression: the `EventSeries` builder shipped for
 * two months emitting `subEvent[]` with no `location`, which Google Rich
 * Results flagged as "Missing field location" (360 errors) — and the
 * site-health sweep had dropped the richResults signal, so nobody saw it.
 *
 * Per A10 item 5 ("required fields populated, not just block present"), the
 * check verifies `location.address.addressLocality` is actually SET, not merely
 * that a `location` object exists — the exact gap the EH3 P2 6/22 check missed.
 *
 * Scope: validates `buildPlaceJsonLd` (the shared Place node now used by BOTH
 * the EventSchema component AND the EventSeries builder) and
 * `buildEventSeriesJsonLd`. The EventSchema component sources its `location`
 * from `buildPlaceJsonLd`, so this transitively guards the event-page location;
 * the component's own field wiring is covered by EventSchema.test.tsx. Pure —
 * no React render, no D1, no network.
 *
 * Usage:  npx tsx scripts/check-event-jsonld-fields.ts   (exit 1 on any miss)
 */
import { buildPlaceJsonLd } from "../src/lib/seo/place-jsonld";
import { buildEventSeriesJsonLd } from "../src/lib/series/series-schema-org";

const failures: string[] = [];
function require_(label: string, cond: unknown) {
  if (!cond) failures.push(label);
}

type Json = Record<string, unknown>;
function asObj(v: unknown): Json {
  return (v && typeof v === "object" ? v : {}) as Json;
}

const VENUE = {
  name: "Skowhegan State Fairgrounds",
  address: "17 Constitution Ave",
  city: "Skowhegan",
  state: "ME",
  zip: "04976",
  latitude: 44.766,
  longitude: -69.719,
};

// ── Place node (shared by Event + EventSeries + Venue templates) ────────────
const place = buildPlaceJsonLd(VENUE);
const placeAddr = asObj(place.address);
require_("Place.@type === 'Place'", place["@type"] === "Place");
require_("Place.name (populated)", typeof place.name === "string" && place.name.length > 0);
require_("Place.address.addressLocality (populated)", placeAddr.addressLocality === "Skowhegan");
require_("Place.address.addressRegion (populated)", placeAddr.addressRegion === "ME");
require_("Place.address.addressCountry", placeAddr.addressCountry === "US");

// A venueless event must STILL emit a Place (never a missing-location error).
const placeFallback = buildPlaceJsonLd(null, "ME");
require_("Place(null) still emits a Place", asObj(placeFallback)["@type"] === "Place");
require_("Place(null).name present", typeof asObj(placeFallback).name === "string");

// ── EventSeries template ────────────────────────────────────────────────────
const series = buildEventSeriesJsonLd(
  {
    canonicalSlug: "skowhegan-state-fair",
    name: "Skowhegan State Fair",
    venue: VENUE,
    startDateIso: "2026-08-13",
    endDateIso: "2026-08-22",
  },
  [
    {
      slug: "skowhegan-state-fair-2026",
      year: 2026,
      name: "Skowhegan State Fair",
      startDateIso: "2026-08-13",
      endDateIso: "2026-08-22",
      venue: VENUE,
    },
  ]
);
const sLoc = asObj(series.location);
const sAddr = asObj(sLoc.address);
require_("EventSeries.name", series.name);
require_("EventSeries.startDate", series.startDate);
require_("EventSeries.location", sLoc["@type"] === "Place");
require_(
  "EventSeries.location.address.addressLocality (populated)",
  sAddr.addressLocality === "Skowhegan"
);

const subs = Array.isArray(series.subEvent) ? (series.subEvent as Json[]) : [];
require_("EventSeries.subEvent[] non-empty", subs.length > 0);
subs.forEach((sub, i) => {
  const subLoc = asObj(sub.location);
  const subAddr = asObj(subLoc.address);
  require_(`EventSeries.subEvent[${i}].location`, subLoc["@type"] === "Place");
  require_(
    `EventSeries.subEvent[${i}].location.address.addressLocality (populated)`,
    subAddr.addressLocality === "Skowhegan"
  );
  require_(`EventSeries.subEvent[${i}].startDate`, sub.startDate);
});

if (failures.length > 0) {
  console.error("FAIL: event JSON-LD is missing required fields:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nThese are required by Google Rich Results (Event → name, startDate, location).");
  process.exit(1);
}
console.log(
  "OK: Place + EventSeries JSON-LD emit all required fields (name, startDate, location)."
);
process.exit(0);
