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
// OPE-32 — a dated series must still emit a node (and carry startDate below).
require_("EventSeries node emitted for a dated series", series !== null);
if (!series) throw new Error("dated EventSeries fixture was unexpectedly suppressed");
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

// ── OPE-18 — WARNING-set spot-check (advisory; never blocks the build) ───────
// The Google-recommended Event fields (endDate, eventStatus, image, description,
// organizer, offers). These are not required, so a miss is a CI-log WARNING, not
// a failure — but surfacing them per build catches the K46/K48 "null on the
// parent because the data lives in a child row" class before GSC does, one field
// at a time. Driven by a FULLY-POPULATED EventSeries fixture so the builder's
// WARNING-set wiring is exercised; genuinely-null source data on a real page is
// expected and fine.
const warnings: string[] = [];
function warn_(label: string, cond: unknown) {
  if (!cond) warnings.push(label);
}

const richSeries = buildEventSeriesJsonLd(
  {
    canonicalSlug: "skowhegan-state-fair",
    name: "Skowhegan State Fair",
    venue: VENUE,
    startDateIso: "2026-08-13",
    endDateIso: "2026-08-22",
    description: "Maine's oldest agricultural fair.",
    imageUrl: "https://cdn.meetmeatthefair.com/series/skowhegan.jpg",
    lifecycleStatus: "SCHEDULED",
    organizer: {
      name: "Skowhegan State Fair Association",
      url: "https://skowheganstatefair.com",
      logoUrl: "https://cdn.meetmeatthefair.com/promoters/skowhegan-logo.png",
    },
  },
  [
    {
      slug: "skowhegan-state-fair-2026",
      year: 2026,
      name: "Skowhegan State Fair",
      startDateIso: "2026-08-13",
      endDateIso: "2026-08-22",
      venue: VENUE,
      lifecycleStatus: "SCHEDULED",
      description: "Ten days of agriculture, midway, and harness racing.",
      imageUrl: "https://cdn.meetmeatthefair.com/events/skowhegan-2026.jpg",
      ticketUrl: "https://skowheganstatefair.com/tickets",
      ticketPriceMinCents: 1000,
      ticketPriceMaxCents: 1500,
    },
  ]
);

if (!richSeries) throw new Error("dated rich EventSeries fixture was unexpectedly suppressed");
const WARNING_FIELDS = ["endDate", "eventStatus", "image", "description", "organizer"] as const;
for (const f of WARNING_FIELDS) {
  warn_(`EventSeries.${f}`, richSeries[f] != null);
}
const richSubs = Array.isArray(richSeries.subEvent) ? (richSeries.subEvent as Json[]) : [];
richSubs.forEach((sub, i) => {
  for (const f of [...WARNING_FIELDS, "offers"] as const) {
    warn_(`EventSeries.subEvent[${i}].${f}`, sub[f] != null);
  }
});

// ── OPE-32 — dateless suppression (the invariant: emitted ⇒ has startDate) ───
// A genuinely-dateless series (no startDateIso, no dated occurrence) must emit
// NOTHING rather than an invalid Event/EventSeries node. A dated series still
// emits, dropping only its dateless subEvents.
const datelessSeries = buildEventSeriesJsonLd(
  { canonicalSlug: "tbd-fair", name: "TBD Fair", venue: VENUE },
  [{ slug: "tbd-fair", year: null, name: "TBD Fair", venue: VENUE }]
);
require_("EventSeries suppressed when no startDate (OPE-32)", datelessSeries === null);

const mixedSeries = buildEventSeriesJsonLd(
  { canonicalSlug: "mixed-fair", name: "Mixed Fair", venue: VENUE, startDateIso: "2026-08-13" },
  [
    {
      slug: "mixed-2026",
      year: 2026,
      name: "Mixed 2026",
      startDateIso: "2026-08-13",
      venue: VENUE,
    },
    { slug: "mixed-tbd", year: null, name: "Mixed TBD", venue: VENUE },
  ]
);
require_("Dated EventSeries still emitted (OPE-32)", mixedSeries !== null);
if (mixedSeries) {
  const mSubs = Array.isArray(mixedSeries.subEvent) ? (mixedSeries.subEvent as Json[]) : [];
  require_("Dateless subEvent dropped (OPE-32)", mSubs.length === 1);
  mSubs.forEach((sub) =>
    require_("Emitted subEvent carries startDate (OPE-32)", sub.startDate != null)
  );
}

if (failures.length > 0) {
  console.error("FAIL: event JSON-LD is missing required fields:");
  for (const f of failures) console.error(`  ✗ ${f}`);
  console.error("\nThese are required by Google Rich Results (Event → name, startDate, location).");
  process.exit(1);
}
if (warnings.length > 0) {
  console.warn("WARN: event JSON-LD is missing recommended (WARNING-set) fields:");
  for (const w of warnings) console.warn(`  ⚠ ${w}`);
  console.warn(
    "\nThese are Google-recommended (endDate, eventStatus, image, description, organizer, offers)."
  );
}
console.log(
  "OK: Place + EventSeries JSON-LD emit all required fields (name, startDate, location)." +
    (warnings.length === 0 ? " WARNING-set fields all present on the populated fixture." : "")
);
process.exit(0);
