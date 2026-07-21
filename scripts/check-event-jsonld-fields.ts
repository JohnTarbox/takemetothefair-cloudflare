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
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { buildPlaceJsonLd } from "../src/lib/seo/place-jsonld";
import { buildPerformerInEvents } from "../src/lib/performers/performer-in-jsonld";
import { buildEventSeriesJsonLd } from "../src/lib/series/series-schema-org";
import { extractHelpFaqItems } from "../src/lib/help-faq";
import { HELP_ARTICLES } from "../src/lib/help-articles";

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
// OPE-244 #4 — a venue-less event with a known state now emits an
// AdministrativeArea (a schema.org Place subtype, valid as Event.location);
// without a state it stays a generic Place. Both satisfy Google's location req.
require_(
  "Place(null) emits a Place or AdministrativeArea",
  ["Place", "AdministrativeArea"].includes(String(asObj(placeFallback)["@type"]))
);
require_("Place(null).name present", typeof asObj(placeFallback).name === "string");
// The AdministrativeArea path is named for the state, not "to be announced".
require_("Place(null,'ME').name is the state name", asObj(placeFallback).name === "Maine");

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

// ── OPE-62 — Help-page JSON-LD (FAQPage on /help/faq + Article on task guides) ─
// Same K46 discipline as the Event schema above: never ship JSON-LD without a
// deploy-time field check. The /help/faq page renders <FAQPageSchema
// items={extractHelpFaqItems(faqBody)} />, so we assert that parse produces a
// non-degenerate, fully-populated FAQPage. A malformed FAQ body (heading shape
// drift, empty answers) fails the build here rather than shipping empty/invalid
// FAQPage JSON-LD.
const faqArticle = HELP_ARTICLES.find((a) => a.slug === "faq");
require_("Help `faq` article exists", faqArticle);
const helpFaqItems = faqArticle ? extractHelpFaqItems(faqArticle.body) : [];
require_("Help FAQPage has >=3 items (FAQ_MIN_ITEMS)", helpFaqItems.length >= 3);
helpFaqItems.forEach((item, i) => {
  require_(
    `Help FAQPage.mainEntity[${i}].name (question populated)`,
    typeof item.question === "string" && item.question.trim().length > 0
  );
  require_(
    `Help FAQPage.mainEntity[${i}].acceptedAnswer.text (answer populated)`,
    typeof item.answer === "string" && item.answer.trim().length > 0
  );
});

// Task-guide help articles render <ArticleSchema headline={title}
// description={description} …/>. Assert a representative task guide carries a
// non-empty Article headline + description (the two Article fields we emit).
const taskGuideCategories = new Set([
  "For Fairgoers",
  "For Vendors & Exhibitors",
  "For Promoters",
  "Developers",
]);
const taskGuide = HELP_ARTICLES.find((a) => taskGuideCategories.has(a.category));
require_("A task-guide help article exists", taskGuide);
require_(
  "Help Article.headline (title populated)",
  typeof taskGuide?.title === "string" && taskGuide.title.trim().length > 0
);
require_(
  "Help Article.description (populated)",
  typeof taskGuide?.description === "string" && taskGuide.description.trim().length > 0
);

// ── OPE-263: performerIn Event nodes (the third emit surface) ───────────────
//
// The performer page shipped `{ "@type": "Event", name, url, startDate? }` with
// no `location`, and both indexed performer pages returned Rich Results
// FAIL — "Missing field location". This guard could not see it: it imports pure
// builders, and that literal lived inside a React component. The mapping is now
// a pure builder precisely so it is reachable from here.
{
  const withVenue = buildPerformerInEvents(
    [
      {
        name: "Topsham Fair",
        slug: "topsham-fair",
        startDate: new Date("2026-08-11T00:00:00Z"),
        venue: {
          name: "Topsham Fairgrounds",
          address: "54 Elm St",
          city: "Topsham",
          state: "ME",
          zip: "04086",
          latitude: 43.96,
          longitude: -69.97,
        },
      },
    ],
    "https://meetmeatthefair.com"
  );
  const ev = withVenue[0] as Json | undefined;
  require_("performerIn: emits one node for a dated event", withVenue.length === 1);
  require_("performerIn Event.name", typeof ev?.name === "string" && ev.name);
  require_("performerIn Event.startDate", typeof ev?.startDate === "string" && ev.startDate);
  const loc = ev?.location as Json | undefined;
  require_("performerIn Event.location (present)", loc && typeof loc === "object");
  const addr = loc?.address as Json | undefined;
  require_(
    "performerIn Event.location.address.addressLocality (populated)",
    typeof addr?.addressLocality === "string" && (addr.addressLocality as string).trim().length > 0
  );

  // The no-venue case is the one most likely to regress: buildPlaceJsonLd's
  // fallback must still yield a location, or a performer linked to a
  // venue-less event silently reintroduces the original bug.
  const noVenue = buildPerformerInEvents(
    [
      {
        name: "TBD Fair",
        slug: "tbd-fair",
        startDate: new Date("2026-09-01T00:00:00Z"),
        stateCode: "ME",
      },
    ],
    "https://meetmeatthefair.com"
  );
  require_(
    "performerIn Event.location present even with NO venue",
    (noVenue[0] as Json | undefined)?.location != null
  );

  // OPE-32 precedent: absent beats invalid.
  const dateless = buildPerformerInEvents([{ name: "No Date", slug: "no-date" }], "https://x.test");
  require_("performerIn: a dateless event is DROPPED, not emitted invalid", dateless.length === 0);
}

// ── OPE-263: emit-site registry ─────────────────────────────────────────────
//
// The durable half. The bug survived OPE-244 because the guard knew about two
// builders BY NAME and a third emit site existed that nobody had told it about.
// So: enumerate every file that emits an `@type: Event` node and fail on any
// that is not registered here. Adding a new emitter is then a deliberate act —
// you must either route it through a guarded builder or add it below with a
// reason, rather than shipping an unvalidated fourth surface by accident.
const REGISTERED_EVENT_EMITTERS = new Set([
  // location ← buildPlaceJsonLd (asserted above); fields covered by EventSchema.test.tsx
  "src/components/seo/EventSchema.tsx",
  // subEvent/occurrence + series nodes — asserted above
  "src/lib/series/series-schema-org.ts",
  // performerIn — asserted above
  "src/lib/performers/performer-in-jsonld.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry === "__tests__") continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

const EMIT_RE = /"@type"\s*:\s*"Event"/;
const emitSites: string[] = [];
for (const root of ["src", "mcp-server/src"]) {
  let files: string[] = [];
  try {
    files = walk(root);
  } catch {
    continue; // root absent in some checkouts
  }
  for (const f of files) {
    if (/\.(test|spec)\.tsx?$/.test(f)) continue;
    if (EMIT_RE.test(readFileSync(f, "utf8"))) emitSites.push(relative(process.cwd(), f));
  }
}

for (const site of emitSites) {
  require_(
    `UNREGISTERED @type:Event emit site: ${site} — route it through a guarded builder, ` +
      "or add it to REGISTERED_EVENT_EMITTERS in this script with assertions",
    REGISTERED_EVENT_EMITTERS.has(site)
  );
}
// Also fail if a registered emitter disappears — a stale registry gives false
// confidence that a surface is covered when it no longer exists.
for (const reg of REGISTERED_EVENT_EMITTERS) {
  require_(
    `registered emitter no longer emits @type:Event (stale entry): ${reg}`,
    emitSites.includes(reg)
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
  "OK: Place + EventSeries JSON-LD emit all required fields (name, startDate, location); " +
    `Help FAQPage has ${helpFaqItems.length} populated Q&A pairs + task-guide Article headline/description present.` +
    (warnings.length === 0 ? " WARNING-set fields all present on the populated fixture." : "")
);
process.exit(0);
